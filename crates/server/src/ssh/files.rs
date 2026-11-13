use crate::{
    protocol::{ClientMsg, ServerMsg},
    AppState,
};
use futures_util::{SinkExt, StreamExt};
use russh_sftp::{
    client::{error::Error as SftpError, RawSftpSession},
    protocol::{FileAttributes, OpenFlags, Packet, StatusCode},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

mod shell;

const CHUNK: usize = 64 * 1024;
const TIMEOUT: Duration = Duration::from_secs(30);
const IDLE: Duration = Duration::from_secs(300);
type Relay = crate::device::client::WsStream;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum FileOperation {
    Open,
    Close {
        session: String,
    },
    List {
        session: String,
        path: String,
    },
    Stat {
        session: String,
        path: String,
    },
    Read {
        session: String,
        path: String,
        offset: u64,
        length: u32,
    },
    Write {
        session: String,
        path: String,
        offset: u64,
        data: String,
        truncate: bool,
    },
    Mkdir {
        session: String,
        path: String,
    },
    Rename {
        session: String,
        from: String,
        to: String,
    },
    Remove {
        session: String,
        path: String,
    },
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FileEntry {
    pub name: String,
    pub kind: String,
    pub size: u64,
    pub modified: Option<u32>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FileResult {
    Opened {
        session: String,
        path: String,
    },
    Listed {
        path: String,
        entries: Vec<FileEntry>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        protocol: Option<String>,
    },
    Stat {
        entry: FileEntry,
    },
    Data {
        data: String,
        eof: bool,
    },
    Ok,
}
enum Connection {
    Local {
        sftp: RawSftpSession,
        posix_rename: bool,
        ssh: russh::client::Handle<super::session::HostKeyChecker>,
    },
    Shell {
        ssh: russh::client::Handle<super::session::HostKeyChecker>,
    },
    Relay {
        socket: Relay,
        host: String,
        session: String,
    },
}
struct FileSession {
    _permits: [tokio::sync::OwnedSemaphorePermit; 2],
    owner: String,
    host: String,
    used: Mutex<Instant>,
    connection: tokio::sync::Mutex<Connection>,
}
pub(crate) struct FileStore {
    slots: Arc<tokio::sync::Semaphore>,
    owners: Mutex<HashMap<String, std::sync::Weak<tokio::sync::Semaphore>>>,
    sessions: Arc<Mutex<HashMap<String, Arc<FileSession>>>>,
}

impl Default for FileStore {
    fn default() -> Self {
        Self {
            slots: Arc::new(tokio::sync::Semaphore::new(32)),
            owners: Mutex::new(HashMap::new()),
            sessions: Default::default(),
        }
    }
}
impl FileStore {
    fn reserve(&self, owner: &str) -> Result<[tokio::sync::OwnedSemaphorePermit; 2], String> {
        let global = self
            .slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| "文件服务繁忙，请稍后重试")?;
        let owner_slots = {
            let mut owners = self.owners.lock().unwrap();
            owners.retain(|_, weak| weak.strong_count() > 0);
            match owners.get(owner).and_then(|w| w.upgrade()) {
                Some(slots) => slots,
                None => {
                    let slots = Arc::new(tokio::sync::Semaphore::new(8));
                    owners.insert(owner.into(), Arc::downgrade(&slots));
                    slots
                }
            }
        };
        let local = owner_slots
            .try_acquire_owned()
            .map_err(|_| "文件连接数量已达上限，请先关闭其他文件面板")?;
        Ok([global, local])
    }
}
impl FileOperation {
    fn session(&self) -> Option<&str> {
        match self {
            Self::Open => None,
            Self::Close { session }
            | Self::List { session, .. }
            | Self::Stat { session, .. }
            | Self::Read { session, .. }
            | Self::Write { session, .. }
            | Self::Mkdir { session, .. }
            | Self::Rename { session, .. }
            | Self::Remove { session, .. } => Some(session),
        }
    }
    fn set_session(&mut self, value: &str) {
        match self {
            Self::Open => (),
            Self::Close { session }
            | Self::List { session, .. }
            | Self::Stat { session, .. }
            | Self::Read { session, .. }
            | Self::Write { session, .. }
            | Self::Mkdir { session, .. }
            | Self::Rename { session, .. }
            | Self::Remove { session, .. } => *session = value.into(),
        }
    }
    fn validate(&self) -> Result<(), String> {
        let paths: Vec<&str> = match self {
            Self::List { path, .. }
            | Self::Stat { path, .. }
            | Self::Read { path, .. }
            | Self::Write { path, .. }
            | Self::Mkdir { path, .. }
            | Self::Remove { path, .. } => vec![path],
            Self::Rename { from, to, .. } => vec![from, to],
            _ => vec![],
        };
        if paths
            .iter()
            .any(|p| p.is_empty() || p.len() > 4096 || p.contains('\0'))
        {
            return Err("文件路径无效或过长".into());
        }
        match self {
            Self::Read { length, .. } if *length == 0 || *length as usize > CHUNK => {
                Err("读取块大小必须为 1–65536 字节".into())
            }
            Self::Read { offset, .. } | Self::Write { offset, .. }
                if *offset > 9_007_199_254_740_991u64 - CHUNK as u64 =>
            {
                Err("文件偏移超出支持范围".into())
            }
            Self::Write { data, .. } if data.len() > CHUNK * 2 || data.len() % 2 != 0 => {
                Err("上传块过大或编码无效".into())
            }
            _ => Ok(()),
        }
    }
}

pub async fn execute(
    state: &AppState,
    owner: &str,
    host_id: &str,
    operation: FileOperation,
) -> Result<FileResult, String> {
    operation.validate()?;
    let token = operation.session().map(str::to_owned);
    match tokio::time::timeout(TIMEOUT, execute_inner(state, owner, host_id, operation)).await {
        Ok(result) => result,
        Err(_) => {
            // A canceled SFTP request may still own a remote handle; discard its connection.
            let expired = token.and_then(|token| {
                let mut sessions = state.ssh.files.sessions.lock().unwrap();
                if sessions
                    .get(&token)
                    .is_some_and(|s| s.owner == owner && s.host == host_id)
                {
                    sessions.remove(&token)
                } else {
                    None
                }
            });
            if let Some(session) = expired {
                close_session(&session).await;
            }
            Err("SSH 文件操作超时，请重新打开文件面板".into())
        }
    }
}
async fn execute_inner(
    state: &AppState,
    owner: &str,
    host_id: &str,
    mut operation: FileOperation,
) -> Result<FileResult, String> {
    let store = &state.ssh.files;
    if matches!(operation, FileOperation::Open) {
        let permits = store.reserve(owner)?;
        let record = state
            .ssh
            .registry_snapshot()
            .into_iter()
            .find(|r| r.id == host_id);
        let (connection, path) = if let Some(record) = record {
            let ssh = super::session::connect_and_auth(&record)
                .await
                .map_err(|e| e.message())?;
            match open_sftp(&ssh).await {
                Ok((sftp, posix_rename, path)) => (
                    Connection::Local {
                        sftp,
                        posix_rename,
                        ssh,
                    },
                    path,
                ),
                Err(reason) => {
                    tracing::debug!(
                        host_id,
                        reason,
                        "SFTP unavailable; probing SSH file commands"
                    );
                    let path = shell::probe(&ssh).await.map_err(|error| {
                        format!("设备未提供可用的 SFTP，SSH 文件兼容模式也不可用：{error}")
                    })?;
                    (Connection::Shell { ssh }, path)
                }
            }
        } else {
            let (device, rest) = host_id.split_once("::").ok_or("未知 SSH 设备")?;
            let mut socket = state.devices.connect_files(device).await?;
            match relay_request(&mut socket, rest, FileOperation::Open).await? {
                FileResult::Opened { session, path } => (
                    Connection::Relay {
                        socket,
                        host: rest.into(),
                        session,
                    },
                    path,
                ),
                _ => return Err("远端文件协议响应无效".into()),
            }
        };
        let token = uuid::Uuid::new_v4().to_string();
        let session = Arc::new(FileSession {
            _permits: permits,
            owner: owner.into(),
            host: host_id.into(),
            used: Mutex::new(Instant::now()),
            connection: tokio::sync::Mutex::new(connection),
        });
        store
            .sessions
            .lock()
            .unwrap()
            .insert(token.clone(), session);
        let weak = Arc::downgrade(&store.sessions);
        let key = token.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(60)).await;
                let Some(map) = weak.upgrade() else {
                    break;
                };
                let expired = {
                    let mut sessions = map.lock().unwrap();
                    match sessions.get(&key) {
                        None => break,
                        Some(s) if s.used.lock().unwrap().elapsed() >= IDLE => {
                            sessions.remove(&key)
                        }
                        _ => None,
                    }
                };
                if let Some(s) = expired {
                    close_session(&s).await;
                    break;
                }
            }
        });
        return Ok(FileResult::Opened {
            session: token,
            path,
        });
    }
    let token = operation.session().ok_or("缺少文件会话")?.to_string();
    let session = store
        .sessions
        .lock()
        .unwrap()
        .get(&token)
        .cloned()
        .filter(|s| s.owner == owner && s.host == host_id)
        .ok_or("文件会话已关闭，请重新打开文件面板")?;
    *session.used.lock().unwrap() = Instant::now();
    if matches!(operation, FileOperation::Close { .. }) {
        store.sessions.lock().unwrap().remove(&token);
        close_session(&session).await;
        return Ok(FileResult::Ok);
    }
    let mut connection = session.connection.lock().await;
    match &mut *connection {
        Connection::Local {
            sftp, posix_rename, ..
        } => local_request(sftp, *posix_rename, operation).await,
        Connection::Shell { ssh } => shell::execute(ssh, operation).await,
        Connection::Relay {
            socket,
            host,
            session,
        } => {
            operation.set_session(session);
            relay_request(socket, host, operation).await
        }
    }
}
async fn relay_request(
    socket: &mut Relay,
    host: &str,
    operation: FileOperation,
) -> Result<FileResult, String> {
    let request_id = uuid::Uuid::new_v4().to_string();
    let msg = ClientMsg::SshFiles {
        request_id: request_id.clone(),
        host_id: host.into(),
        operation,
    };
    socket
        .send(tokio_tungstenite::tungstenite::Message::Text(
            serde_json::to_string(&msg).map_err(|e| e.to_string())?,
        ))
        .await
        .map_err(|e| e.to_string())?;
    while let Some(message) = socket.next().await {
        match message.map_err(|e| e.to_string())? {
            tokio_tungstenite::tungstenite::Message::Text(text) => {
                if let Ok(ServerMsg::SshFilesResult {
                    request_id: id,
                    result,
                    error,
                }) = serde_json::from_str(&text)
                {
                    if id == request_id {
                        return result.ok_or_else(|| error.unwrap_or("远端文件操作失败".into()));
                    }
                }
            }
            tokio_tungstenite::tungstenite::Message::Close(_) => break,
            _ => (),
        }
    }
    Err("远程设备连接已断开".into())
}

async fn open_sftp(
    ssh: &russh::client::Handle<super::session::HostKeyChecker>,
) -> Result<(RawSftpSession, bool, String), String> {
    let mut channel = ssh
        .channel_open_session()
        .await
        .map_err(|e| e.to_string())?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|e| e.to_string())?;
    let confirmation = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            match channel.wait().await {
                Some(russh::ChannelMsg::Success) => return Ok(()),
                Some(
                    russh::ChannelMsg::Failure | russh::ChannelMsg::Close | russh::ChannelMsg::Eof,
                )
                | None => {
                    return Err("设备拒绝或关闭了 SFTP 子系统".to_string());
                }
                _ => (),
            }
        }
    })
    .await;
    if !matches!(confirmation, Ok(Ok(()))) {
        let _ = channel.close().await;
        return Err(match confirmation {
            Ok(Err(error)) => error,
            _ => "设备未响应 SFTP 子系统请求".into(),
        });
    }
    let sftp = RawSftpSession::new(channel.into_stream());
    let initialized = tokio::time::timeout(Duration::from_secs(3), async {
        let version = sftp.init().await.map_err(|_| "SFTP 子系统未完成初始化")?;
        let posix = version.extensions.contains_key("posix-rename@openssh.com");
        let path = canonicalize(&sftp, ".").await?;
        Ok::<_, String>((posix, path))
    })
    .await;
    match initialized {
        Ok(Ok((posix, path))) => Ok((sftp, posix, path)),
        result => {
            let _ = sftp.close_session();
            Err(match result {
                Ok(Err(error)) => error,
                _ => "SFTP 子系统初始化超时".into(),
            })
        }
    }
}

async fn close_session(session: &FileSession) {
    let _ = tokio::time::timeout(Duration::from_secs(2), async {
        match &mut *session.connection.lock().await {
            Connection::Local { sftp, ssh, .. } => {
                let _ = sftp.close_session();
                let _ = ssh
                    .disconnect(
                        russh::Disconnect::ByApplication,
                        "files closed",
                        "Serial Studio",
                    )
                    .await;
            }
            Connection::Shell { ssh } => {
                let _ = ssh
                    .disconnect(
                        russh::Disconnect::ByApplication,
                        "files closed",
                        "Serial Studio",
                    )
                    .await;
            }
            Connection::Relay { socket, .. } => {
                let _ = socket.close(None).await;
            }
        }
    })
    .await;
}
pub async fn release_owner(state: &AppState, owner: &str) {
    let sessions = {
        let mut map = state.ssh.files.sessions.lock().unwrap();
        let keys: Vec<_> = map
            .iter()
            .filter(|(_, s)| s.owner == owner)
            .map(|(k, _)| k.clone())
            .collect();
        keys.into_iter()
            .filter_map(|k| map.remove(&k))
            .collect::<Vec<_>>()
    };
    for session in sessions {
        close_session(&session).await;
    }
}
fn entry(name: String, attr: FileAttributes) -> FileEntry {
    FileEntry {
        name,
        kind: if attr.is_dir() {
            "directory"
        } else if attr.is_symlink() {
            "symlink"
        } else if attr.is_regular() {
            "file"
        } else {
            "other"
        }
        .into(),
        size: attr.size.unwrap_or(0),
        modified: attr.mtime,
    }
}
async fn canonicalize(sftp: &RawSftpSession, path: &str) -> Result<String, String> {
    sftp.realpath(path)
        .await
        .map_err(|e| e.to_string())?
        .files
        .into_iter()
        .next()
        .map(|f| f.filename)
        .ok_or("远端返回空路径".into())
}
fn is_eof(error: &SftpError) -> bool {
    matches!(error, SftpError::Status(status) if status.status_code == StatusCode::Eof)
}
async fn local_request(
    sftp: &RawSftpSession,
    posix_rename: bool,
    operation: FileOperation,
) -> Result<FileResult, String> {
    match operation {
        FileOperation::List { path, .. } => {
            let path = canonicalize(sftp, &path).await?;
            let handle = sftp
                .opendir(path.clone())
                .await
                .map_err(|e| e.to_string())?
                .handle;
            let result: Result<FileResult, String> = async {
                let mut entries = Vec::new();
                loop {
                    match sftp.readdir(handle.clone()).await {
                        Ok(batch) => {
                            if batch.files.is_empty() {
                                break;
                            }
                            for file in batch.files {
                                if file.filename == "." || file.filename == ".." {
                                    continue;
                                }
                                if entries.len() >= 10000 {
                                    return Err("目录超过 10000 项，请进入更具体的目录".into());
                                }
                                entries.push(entry(file.filename, file.attrs));
                            }
                        }
                        Err(error) if is_eof(&error) => break,
                        Err(error) => return Err(error.to_string()),
                    }
                }
                Ok(FileResult::Listed {
                    path,
                    entries,
                    protocol: Some("sftp".into()),
                })
            }
            .await;
            let _ = sftp.close(handle).await;
            result
        }
        FileOperation::Stat { path, .. } => {
            let attr = sftp
                .lstat(path.clone())
                .await
                .map_err(|e| e.to_string())?
                .attrs;
            Ok(FileResult::Stat {
                entry: entry(path.rsplit('/').next().unwrap_or(&path).into(), attr),
            })
        }
        FileOperation::Read {
            path,
            offset,
            length,
            ..
        } => {
            let handle = sftp
                .open(path, OpenFlags::READ, FileAttributes::empty())
                .await
                .map_err(|e| e.to_string())?
                .handle;
            let result: Result<FileResult, String> = async {
                let mut bytes = Vec::with_capacity(length as usize);
                let mut eof = false;
                while bytes.len() < length as usize {
                    let count = (length as usize - bytes.len()).min(32768) as u32;
                    match sftp
                        .read(handle.clone(), offset + bytes.len() as u64, count)
                        .await
                    {
                        Ok(data) if data.data.is_empty() => {
                            eof = true;
                            break;
                        }
                        Ok(data) => {
                            if data.data.len() > count as usize {
                                return Err("远端返回的文件数据超过请求长度".into());
                            }
                            bytes.extend_from_slice(&data.data);
                        }
                        Err(error) if is_eof(&error) => {
                            eof = true;
                            break;
                        }
                        Err(error) => return Err(error.to_string()),
                    }
                }
                Ok(FileResult::Data {
                    data: hex::encode(bytes),
                    eof,
                })
            }
            .await;
            let _ = sftp.close(handle).await;
            result
        }
        FileOperation::Write {
            path,
            offset,
            data,
            truncate,
            ..
        } => {
            let bytes = hex::decode(data).map_err(|_| "上传编码无效")?;
            let flags = OpenFlags::CREATE
                | OpenFlags::WRITE
                | if truncate {
                    OpenFlags::TRUNCATE
                } else {
                    OpenFlags::empty()
                };
            let handle = sftp
                .open(path, flags, FileAttributes::empty())
                .await
                .map_err(|e| e.to_string())?
                .handle;
            let result: Result<FileResult, String> = async {
                for (i, chunk) in bytes.chunks(32768).enumerate() {
                    sftp.write(handle.clone(), offset + (i * 32768) as u64, chunk.to_vec())
                        .await
                        .map_err(|e| e.to_string())?;
                }
                Ok(FileResult::Ok)
            }
            .await;
            let close = sftp.close(handle).await;
            let value = result?;
            close.map_err(|e| e.to_string())?;
            Ok(value)
        }
        FileOperation::Mkdir { path, .. } => {
            if let Err(error) = sftp.mkdir(path.clone(), FileAttributes::empty()).await {
                if !sftp
                    .stat(path)
                    .await
                    .map(|m| m.attrs.is_dir())
                    .unwrap_or(false)
                {
                    return Err(error.to_string());
                }
            }
            Ok(FileResult::Ok)
        }
        FileOperation::Rename { from, to, .. } => {
            if posix_rename {
                let mut data = Vec::new();
                for path in [&from, &to] {
                    data.extend_from_slice(&(path.len() as u32).to_be_bytes());
                    data.extend_from_slice(path.as_bytes());
                }
                match sftp
                    .extended("posix-rename@openssh.com", data)
                    .await
                    .map_err(|e| e.to_string())?
                {
                    Packet::Status(status) if status.status_code == StatusCode::Ok => (),
                    Packet::Status(status) => {
                        return Err(format!("{}: {}", status.status_code, status.error_message))
                    }
                    _ => return Err("远端重命名响应无效".into()),
                }
            } else {
                match sftp.lstat(to.clone()).await {
                    Ok(_) => return Err("此服务器不支持原子替换，同名文件已存在，不会覆盖".into()),
                    Err(SftpError::Status(status))
                        if status.status_code == StatusCode::NoSuchFile =>
                    {
                        ()
                    }
                    Err(error) => return Err(error.to_string()),
                }
                sftp.rename(from, to).await.map_err(|e| e.to_string())?;
            }
            Ok(FileResult::Ok)
        }
        FileOperation::Remove { path, .. } => {
            sftp.remove(path).await.map_err(|e| e.to_string())?;
            Ok(FileResult::Ok)
        }
        _ => Err("文件操作无效".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use russh_sftp::protocol::{Attrs, Data, File, Handle, Name, Status, Version};
    use std::collections::HashSet;

    #[derive(Default)]
    struct Fixture {
        files: HashMap<String, Vec<u8>>,
        directories: HashSet<String>,
        listed: bool,
    }
    fn ok(id: u32) -> Status {
        Status {
            id,
            status_code: StatusCode::Ok,
            error_message: String::new(),
            language_tag: String::new(),
        }
    }
    impl russh_sftp::server::Handler for Fixture {
        type Error = StatusCode;
        fn unimplemented(&self) -> Self::Error {
            StatusCode::OpUnsupported
        }
        async fn init(
            &mut self,
            _: u32,
            _: HashMap<String, String>,
        ) -> Result<Version, Self::Error> {
            Ok(Version::new())
        }
        async fn realpath(&mut self, id: u32, path: String) -> Result<Name, Self::Error> {
            Ok(Name {
                id,
                files: vec![File::dummy(if path == "." { "/home/test" } else { &path })],
            })
        }
        async fn open(
            &mut self,
            id: u32,
            filename: String,
            flags: OpenFlags,
            _: FileAttributes,
        ) -> Result<Handle, Self::Error> {
            if filename == "/denied" {
                return Err(StatusCode::PermissionDenied);
            }
            if flags.contains(OpenFlags::TRUNCATE) {
                self.files.insert(filename.clone(), vec![]);
            }
            if flags.contains(OpenFlags::CREATE) {
                self.files.entry(filename.clone()).or_default();
            }
            if !self.files.contains_key(&filename) {
                return Err(StatusCode::NoSuchFile);
            }
            Ok(Handle {
                id,
                handle: filename,
            })
        }
        async fn close(&mut self, id: u32, _: String) -> Result<Status, Self::Error> {
            Ok(ok(id))
        }
        async fn write(
            &mut self,
            id: u32,
            handle: String,
            offset: u64,
            data: Vec<u8>,
        ) -> Result<Status, Self::Error> {
            let bytes = self.files.get_mut(&handle).ok_or(StatusCode::NoSuchFile)?;
            let offset = offset as usize;
            bytes.resize(bytes.len().max(offset + data.len()), 0);
            bytes[offset..offset + data.len()].copy_from_slice(&data);
            Ok(ok(id))
        }
        async fn read(
            &mut self,
            id: u32,
            handle: String,
            offset: u64,
            len: u32,
        ) -> Result<Data, Self::Error> {
            let bytes = self.files.get(&handle).ok_or(StatusCode::NoSuchFile)?;
            let offset = offset as usize;
            if offset >= bytes.len() {
                return Err(StatusCode::Eof);
            }
            // Short packets exercise the client's loop rather than assuming a full read.
            Ok(Data {
                id,
                data: bytes[offset..bytes.len().min(offset + len.min(4096) as usize)].to_vec(),
            })
        }
        async fn stat(&mut self, id: u32, path: String) -> Result<Attrs, Self::Error> {
            let mut attrs = FileAttributes::empty();
            if self.directories.contains(&path) {
                attrs.set_dir(true);
            } else if let Some(bytes) = self.files.get(&path) {
                attrs.set_regular(true);
                attrs.size = Some(bytes.len() as u64);
            } else {
                return Err(StatusCode::NoSuchFile);
            }
            Ok(Attrs { id, attrs })
        }
        async fn lstat(&mut self, id: u32, path: String) -> Result<Attrs, Self::Error> {
            self.stat(id, path).await
        }
        async fn mkdir(
            &mut self,
            id: u32,
            path: String,
            _: FileAttributes,
        ) -> Result<Status, Self::Error> {
            if self.files.contains_key(&path) || !self.directories.insert(path) {
                return Err(StatusCode::Failure);
            }
            Ok(ok(id))
        }
        async fn opendir(&mut self, id: u32, path: String) -> Result<Handle, Self::Error> {
            self.listed = false;
            Ok(Handle { id, handle: path })
        }
        async fn readdir(&mut self, id: u32, _: String) -> Result<Name, Self::Error> {
            if self.listed {
                return Err(StatusCode::Eof);
            }
            self.listed = true;
            let mut attrs = FileAttributes::empty();
            attrs.set_regular(true);
            attrs.size = Some(3);
            Ok(Name {
                id,
                files: vec![
                    File::dummy("."),
                    File::dummy(".."),
                    File::new("文件 ; $(test).txt", attrs),
                ],
            })
        }
        async fn rename(
            &mut self,
            id: u32,
            from: String,
            to: String,
        ) -> Result<Status, Self::Error> {
            if self.files.contains_key(&to) {
                return Err(StatusCode::Failure);
            }
            let data = self.files.remove(&from).ok_or(StatusCode::NoSuchFile)?;
            self.files.insert(to, data);
            Ok(ok(id))
        }
        async fn remove(&mut self, id: u32, filename: String) -> Result<Status, Self::Error> {
            self.files.remove(&filename).ok_or(StatusCode::NoSuchFile)?;
            Ok(ok(id))
        }
        async fn extended(
            &mut self,
            id: u32,
            request: String,
            data: Vec<u8>,
        ) -> Result<Packet, Self::Error> {
            if request != "posix-rename@openssh.com" {
                return Err(StatusCode::OpUnsupported);
            }
            let first_len = u32::from_be_bytes(data[..4].try_into().unwrap()) as usize;
            let from = String::from_utf8(data[4..4 + first_len].to_vec()).unwrap();
            let to = String::from_utf8(data[8 + first_len..].to_vec()).unwrap();
            let bytes = self.files.remove(&from).ok_or(StatusCode::NoSuchFile)?;
            self.files.insert(to, bytes);
            Ok(Packet::Status(ok(id)))
        }
    }
    async fn fixture() -> RawSftpSession {
        let (client, server) = tokio::io::duplex(128 * 1024);
        tokio::spawn(async move {
            russh_sftp::server::run(server, Fixture::default()).await;
        });
        let sftp = RawSftpSession::new(client);
        sftp.init().await.unwrap();
        sftp
    }
    fn write(path: &str, offset: u64, data: &[u8], truncate: bool) -> FileOperation {
        FileOperation::Write {
            session: "test".into(),
            path: path.into(),
            offset,
            data: hex::encode(data),
            truncate,
        }
    }

    #[test]
    fn reservations_cover_inflight_opens_and_return_on_drop() {
        let store = FileStore::default();
        let mut owner: Vec<_> = (0..8).map(|_| store.reserve("first").unwrap()).collect();
        assert!(store.reserve("first").is_err());
        let other = store.reserve("second").unwrap();
        owner.pop();
        assert!(store.reserve("first").is_ok());
        drop(owner);
        drop(other);
        assert_eq!(store.slots.available_permits(), 32);
    }
    #[test]
    fn rejects_unbounded_chunks_and_invalid_paths() {
        assert!(FileOperation::Read {
            session: "x".into(),
            path: "/x".into(),
            offset: 0,
            length: 65537
        }
        .validate()
        .is_err());
        assert!(write("/x", 0, &vec![0; 65537], true).validate().is_err());
        assert!(write("/x\0", 0, b"", true).validate().is_err());
        assert!(write("/中文 $();.txt", 0, b"", true).validate().is_ok());
    }
    #[tokio::test]
    async fn sftp_round_trip_handles_short_reads_and_empty_files() {
        let sftp = fixture().await;
        let payload: Vec<_> = (0..65536).map(|i| (i % 251) as u8).collect();
        local_request(&sftp, false, write("/文件 $().part", 0, &payload, true))
            .await
            .unwrap();
        local_request(&sftp, false, write("/文件 $().part", 65536, b"tail", false))
            .await
            .unwrap();
        let result = local_request(
            &sftp,
            false,
            FileOperation::Read {
                session: "test".into(),
                path: "/文件 $().part".into(),
                offset: 0,
                length: 65536,
            },
        )
        .await
        .unwrap();
        assert!(
            matches!(result, FileResult::Data { data, eof: false } if hex::decode(&data).unwrap() == payload)
        );
        let result = local_request(
            &sftp,
            false,
            FileOperation::Read {
                session: "test".into(),
                path: "/文件 $().part".into(),
                offset: 65536,
                length: 100,
            },
        )
        .await
        .unwrap();
        assert!(
            matches!(result, FileResult::Data { data, eof: true } if data == hex::encode(b"tail"))
        );
        local_request(&sftp, false, write("/empty", 0, b"", true))
            .await
            .unwrap();
        let result = local_request(
            &sftp,
            false,
            FileOperation::Stat {
                session: "test".into(),
                path: "/empty".into(),
            },
        )
        .await
        .unwrap();
        assert!(
            matches!(result, FileResult::Stat { entry } if entry.size == 0 && entry.kind == "file")
        );
        sftp.close_session().unwrap();
    }
    #[tokio::test]
    async fn directories_errors_and_safe_atomic_replacement() {
        let sftp = fixture().await;
        let mkdir = FileOperation::Mkdir {
            session: "test".into(),
            path: "/existing".into(),
        };
        local_request(&sftp, false, mkdir.clone()).await.unwrap();
        local_request(&sftp, false, mkdir).await.unwrap();
        let listed = local_request(
            &sftp,
            false,
            FileOperation::List {
                session: "test".into(),
                path: ".".into(),
            },
        )
        .await
        .unwrap();
        assert!(
            matches!(listed, FileResult::Listed { entries, path, .. } if entries.len() == 1 && path == "/home/test")
        );
        assert!(local_request(&sftp, false, write("/denied", 0, b"x", true))
            .await
            .unwrap_err()
            .contains("Permission denied"));
        local_request(&sftp, false, write("/target", 0, b"old", true))
            .await
            .unwrap();
        local_request(&sftp, false, write("/temporary", 0, b"new", true))
            .await
            .unwrap();
        let rename = FileOperation::Rename {
            session: "test".into(),
            from: "/temporary".into(),
            to: "/target".into(),
        };
        assert!(local_request(&sftp, false, rename.clone()).await.is_err());
        local_request(&sftp, true, rename).await.unwrap();
        let result = local_request(
            &sftp,
            false,
            FileOperation::Read {
                session: "test".into(),
                path: "/target".into(),
                offset: 0,
                length: 10,
            },
        )
        .await
        .unwrap();
        assert!(matches!(result, FileResult::Data { data, .. } if data == hex::encode(b"new")));
        local_request(
            &sftp,
            false,
            FileOperation::Remove {
                session: "test".into(),
                path: "/target".into(),
            },
        )
        .await
        .unwrap();
        sftp.close_session().unwrap();
    }
    fn isolated_state() -> AppState {
        let event_bus = Arc::new(ss_core::EventBus::new(64));
        let manager = Arc::new(ss_core::SerialManager::new(
            event_bus.clone(),
            Arc::new(ss_core::RealPortOpener),
        ));
        let (meta, _) = tokio::sync::broadcast::channel(16);
        let (scripts, _) = tokio::sync::broadcast::channel(16);
        let devices = Arc::new(crate::device::DeviceClientManager::empty(
            meta.clone(),
            "files-test",
        ));
        let ssh = Arc::new(super::super::SshManager::empty());
        AppState {
            access: Default::default(),
            port_groups: Arc::new(crate::port_groups::PortGroupsStore::memory("files-test")),
            manager,
            event_bus,
            meta_bus: Arc::new(meta.clone()),
            script_bus: Arc::new(scripts),
            enable_scripting: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            script_semaphore: Arc::new(tokio::sync::Semaphore::new(4)),
            closers: Default::default(),
            script_runs: Default::default(),
            addresses: Arc::new(crate::address::AddressResolver::new(
                devices.clone(),
                ssh.clone(),
                meta,
                "files-test".into(),
            )),
            devices,
            ssh,
            instance_id: "files-test".into(),
        }
    }
    async fn relay_fixture(
        state: &AppState,
        delay: Duration,
    ) -> (
        tokio::task::JoinHandle<()>,
        Arc<std::sync::atomic::AtomicUsize>,
        Arc<tokio::sync::Notify>,
    ) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        state.devices.update_registry(&[ss_core::RemoteDevice {
            secure_port: None,
            verify_http: false,
            id: "hub".into(),
            host: "127.0.0.1".into(),
            port: listener.local_addr().unwrap().port(),
            nickname: None,
        }]);
        let closed = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let seen = Arc::new(tokio::sync::Notify::new());
        let count = closed.clone();
        let notify = seen.clone();
        let task = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(tcp).await.unwrap();
            while let Some(Ok(message)) = socket.next().await {
                if let tokio_tungstenite::tungstenite::Message::Text(text) = message {
                    let ClientMsg::SshFiles {
                        request_id,
                        host_id,
                        operation,
                    } = serde_json::from_str(&text).unwrap()
                    else {
                        panic!("wrong request")
                    };
                    assert_eq!(host_id, "nested::ssh-host");
                    let result = match operation {
                        FileOperation::Open => {
                            notify.notify_one();
                            tokio::time::sleep(delay).await;
                            FileResult::Opened {
                                session: "remote-token".into(),
                                path: "/home/test".into(),
                            }
                        }
                        FileOperation::List { session, path } => {
                            assert_eq!(session, "remote-token");
                            FileResult::Listed {
                                path,
                                entries: vec![],
                                protocol: None,
                            }
                        }
                        _ => panic!("unexpected operation"),
                    };
                    let response = ServerMsg::SshFilesResult {
                        request_id,
                        result: Some(result),
                        error: None,
                    };
                    if socket
                        .send(tokio_tungstenite::tungstenite::Message::Text(
                            serde_json::to_string(&response).unwrap(),
                        ))
                        .await
                        .is_err()
                    {
                        break;
                    }
                } else if message.is_close() {
                    break;
                }
            }
            count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        });
        (task, closed, seen)
    }
    #[tokio::test]
    async fn relay_tokens_preserve_routes_and_enforce_owner_then_release() {
        let state = isolated_state();
        let (task, closed, _) = relay_fixture(&state, Duration::ZERO).await;
        let host = "hub::nested::ssh-host";
        let opened = execute(&state, "owner-a", host, FileOperation::Open)
            .await
            .unwrap();
        let FileResult::Opened { session, .. } = opened else {
            panic!("not opened")
        };
        assert_ne!(session, "remote-token");
        let list = FileOperation::List {
            session,
            path: "/home/test".into(),
        };
        assert!(execute(&state, "owner-b", host, list.clone())
            .await
            .is_err());
        assert!(execute(&state, "owner-a", "hub::other-host", list.clone())
            .await
            .is_err());
        assert!(matches!(
            execute(&state, "owner-a", host, list.clone())
                .await
                .unwrap(),
            FileResult::Listed { .. }
        ));
        release_owner(&state, "owner-a").await;
        assert!(execute(&state, "owner-a", host, list).await.is_err());
        tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(closed.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert!(state.ssh.files.sessions.lock().unwrap().is_empty());
    }
    #[tokio::test]
    async fn ws_disconnect_cleans_open_that_finishes_late() {
        let state = isolated_state();
        let (remote, closed, seen) = relay_fixture(&state, Duration::from_millis(150)).await;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let router = crate::create_router(state.clone());
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let (mut frontend, _) = tokio_tungstenite::connect_async(format!("ws://{address}/ws"))
            .await
            .unwrap();
        frontend
            .send(tokio_tungstenite::tungstenite::Message::Text(
                serde_json::to_string(&ClientMsg::SshFiles {
                    request_id: "open-late".into(),
                    host_id: "hub::nested::ssh-host".into(),
                    operation: FileOperation::Open,
                })
                .unwrap(),
            ))
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(2), seen.notified())
            .await
            .unwrap();
        frontend.close(None).await.unwrap();
        drop(frontend);
        tokio::time::timeout(Duration::from_secs(3), remote)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(closed.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert!(state.ssh.files.sessions.lock().unwrap().is_empty());
        assert_eq!(state.ssh.files.slots.available_permits(), 32);
        server.abort();
    }
    #[tokio::test]
    async fn unreachable_relay_returns_without_waiting_for_session_timeout() {
        let state = isolated_state();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        state.devices.update_registry(&[ss_core::RemoteDevice {
            secure_port: None,
            verify_http: false,
            id: "hub".into(),
            host: "127.0.0.1".into(),
            port,
            nickname: None,
        }]);
        let result = tokio::time::timeout(
            Duration::from_secs(2),
            execute(&state, "test", "hub::missing", FileOperation::Open),
        )
        .await
        .unwrap();
        assert!(result.is_err());
        assert_eq!(state.ssh.files.slots.available_permits(), 32);
    }
}
