use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex,
};
use tauri::Manager;

const CHUNK: usize = 65_536;
const MAX_ENTRIES: usize = 10_000;
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Default, Clone)]
pub struct LocalFiles(Arc<Mutex<HashMap<String, Grant>>>);

struct Grant {
    owner: String,
    access: Access,
}
enum Access {
    Upload(HashMap<String, PathBuf>),
    Download {
        root: PathBuf,
        directory: bool,
        directories: HashSet<String>,
        pending: HashMap<String, Pending>,
        completed: HashSet<String>,
    },
}
struct Pending {
    file: Option<File>,
    temporary: PathBuf,
    target: PathBuf,
    offset: u64,
}
impl Drop for Pending {
    fn drop(&mut self) {
        drop(self.file.take());
        let _ = fs::remove_file(&self.temporary);
    }
}
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    path: String,
    size: u64,
    is_dir: bool,
}
#[derive(serde::Serialize)]
pub struct Selection {
    id: String,
    entries: Vec<Entry>,
}

fn relative(path: &str) -> Result<PathBuf, String> {
    if path.is_empty() || path.contains('\\') || path.contains('\0') || path.contains(':') {
        return Err("无效的相对文件路径".into());
    }
    let p = Path::new(path);
    if p.components().any(|c| !matches!(c, Component::Normal(_))) {
        return Err("文件路径不能越过选定目录".into());
    }
    Ok(p.into())
}
fn safe_name(path: &Path) -> Result<String, String> {
    path.file_name()
        .and_then(|s| s.to_str())
        .map(str::to_owned)
        .filter(|s| relative(s).is_ok())
        .ok_or_else(|| "文件名不受支持".into())
}
fn collect(
    path: &Path,
    name: String,
    entries: &mut Vec<Entry>,
    files: &mut HashMap<String, PathBuf>,
) -> Result<(), String> {
    if entries.len() >= MAX_ENTRIES {
        return Err("一次最多选择 10000 个文件或目录".into());
    }
    if name.split('/').count() > 64 {
        return Err("文件夹层级超过 64 层".into());
    }
    let meta = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if meta.file_type().is_symlink() {
        return Ok(());
    }
    if !meta.is_file() && !meta.is_dir() {
        return Ok(());
    }
    relative(&name)?;
    if files.contains_key(&name) {
        return Err("所选文件名称重复，请分别上传".into());
    }
    entries.push(Entry {
        path: name.clone(),
        size: meta.len(),
        is_dir: meta.is_dir(),
    });
    if meta.is_file() {
        files.insert(name, fs::canonicalize(path).map_err(|e| e.to_string())?);
    } else {
        for child in fs::read_dir(path).map_err(|e| e.to_string())? {
            let child = child.map_err(|e| e.to_string())?;
            collect(
                &child.path(),
                format!("{name}/{}", safe_name(&child.path())?),
                entries,
                files,
            )?;
        }
    }
    Ok(())
}
fn grant<'a>(
    grants: &'a mut HashMap<String, Grant>,
    id: &str,
    owner: &str,
) -> Result<&'a mut Access, String> {
    grants
        .get_mut(id)
        .filter(|g| g.owner == owner)
        .map(|g| &mut g.access)
        .ok_or_else(|| "文件选择已失效，请重新选择".into())
}
impl LocalFiles {
    pub fn release_window(&self, owner: &str) {
        self.0.lock().unwrap().retain(|_, g| g.owner != owner);
    }
    fn insert(&self, owner: String, access: Access) -> String {
        let id = format!("local-file-{}", NEXT_ID.fetch_add(1, Ordering::Relaxed));
        self.0
            .lock()
            .unwrap()
            .insert(id.clone(), Grant { owner, access });
        id
    }
}

#[tauri::command]
pub async fn ssh_local_pick_upload(
    state: tauri::State<'_, LocalFiles>,
    window: tauri::Window,
    directory: bool,
) -> Result<Option<Selection>, String> {
    let selected: Option<Vec<PathBuf>> = if directory {
        rfd::AsyncFileDialog::new()
            .set_title("选择上传文件夹")
            .pick_folder()
            .await
            .map(|f| vec![f.path().into()])
    } else {
        rfd::AsyncFileDialog::new()
            .set_title("选择上传文件")
            .pick_files()
            .await
            .map(|files| files.into_iter().map(|f| f.path().into()).collect())
    };
    let Some(selected) = selected else {
        return Ok(None);
    };
    let local = state.inner().clone();
    let owner = window.label().to_string();
    tokio::task::spawn_blocking(move || {
        let mut entries = Vec::new();
        let mut files = HashMap::new();
        for path in selected {
            collect(&path, safe_name(&path)?, &mut entries, &mut files)?;
        }
        let id = local.insert(owner.clone(), Access::Upload(files));
        if window.app_handle().get_webview_window(&owner).is_none() {
            local.release_window(&owner);
            return Err("窗口已关闭".into());
        }
        Ok(Some(Selection { id, entries }))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn ssh_local_read(
    state: tauri::State<'_, LocalFiles>,
    window: tauri::Window,
    id: String,
    path: String,
    offset: u64,
    length: usize,
) -> Result<Vec<u8>, String> {
    if length > CHUNK {
        return Err("读取分块过大".into());
    }
    let local = state.inner().clone();
    let owner = window.label().to_string();
    tokio::task::spawn_blocking(move || local.read(&owner, &id, &path, offset, length))
        .await
        .map_err(|e| e.to_string())?
}

impl LocalFiles {
    fn read(
        &self,
        owner: &str,
        id: &str,
        path: &str,
        offset: u64,
        length: usize,
    ) -> Result<Vec<u8>, String> {
        if length > CHUNK {
            return Err("读取分块过大".into());
        }
        let mut grants = self.0.lock().unwrap();
        let Access::Upload(files) = grant(&mut grants, id, owner)? else {
            return Err("所选文件不可读".into());
        };
        let file = files.get(path).ok_or("文件不在选择范围内")?;
        if fs::symlink_metadata(file)
            .map_err(|e| e.to_string())?
            .file_type()
            .is_symlink()
        {
            return Err("不支持符号链接".into());
        }
        let mut f = File::open(file).map_err(|e| e.to_string())?;
        f.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
        let mut data = vec![0; length];
        let n = f.read(&mut data).map_err(|e| e.to_string())?;
        data.truncate(n);
        Ok(data)
    }
}

#[tauri::command]
pub async fn ssh_local_pick_download(
    state: tauri::State<'_, LocalFiles>,
    window: tauri::Window,
    name: String,
    directory: bool,
) -> Result<Option<String>, String> {
    relative(&name)?;
    let selected = if directory {
        rfd::AsyncFileDialog::new()
            .set_title("选择保存位置（同名文件夹不会覆盖）")
            .pick_folder()
            .await
    } else {
        rfd::AsyncFileDialog::new()
            .set_title("保存下载文件")
            .set_file_name(&name)
            .save_file()
            .await
    };
    let Some(selected) = selected else {
        return Ok(None);
    };
    let root = selected.path().to_path_buf();
    if fs::symlink_metadata(&root)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
    {
        return Err("不支持保存到符号链接".into());
    }
    let id = state.insert(
        window.label().to_string(),
        Access::Download {
            root,
            directory,
            directories: HashSet::new(),
            pending: HashMap::new(),
            completed: HashSet::new(),
        },
    );
    if window
        .app_handle()
        .get_webview_window(window.label())
        .is_none()
    {
        state.release_window(window.label());
        return Err("窗口已关闭".into());
    }
    Ok(Some(id))
}

fn target(
    root: &Path,
    directory: bool,
    path: &str,
    directories: &HashSet<String>,
) -> Result<PathBuf, String> {
    if !directory {
        return if path.is_empty() {
            Ok(root.into())
        } else {
            Err("此选择只允许保存单个文件".into())
        };
    }
    let rel = relative(path)?;
    if let Some(parent) = rel.parent().filter(|p| !p.as_os_str().is_empty()) {
        let name = parent.to_str().ok_or("不支持的路径")?;
        if !directories.contains(name) {
            return Err("请先创建父文件夹".into());
        }
    }
    let result = root.join(rel);
    // Reject replaced parents before opening a new destination.
    let mut ancestor = result.parent();
    while let Some(path) = ancestor {
        if fs::symlink_metadata(path)
            .map_err(|e| e.to_string())?
            .file_type()
            .is_symlink()
        {
            return Err("保存路径包含符号链接".into());
        }
        if path == root {
            break;
        }
        ancestor = path.parent();
    }
    Ok(result)
}

#[tauri::command]
pub async fn ssh_local_mkdir(
    state: tauri::State<'_, LocalFiles>,
    window: tauri::Window,
    id: String,
    path: String,
) -> Result<(), String> {
    let local = state.inner().clone();
    let owner = window.label().to_string();
    tokio::task::spawn_blocking(move || local.mkdir(&owner, &id, path))
        .await
        .map_err(|e| e.to_string())?
}

impl LocalFiles {
    fn mkdir(&self, owner: &str, id: &str, path: String) -> Result<(), String> {
        let mut grants = self.0.lock().unwrap();
        let Access::Download {
            root,
            directory,
            directories,
            ..
        } = grant(&mut grants, id, owner)?
        else {
            return Err("所选位置不可写".into());
        };
        if directories.contains(&path) {
            return Ok(());
        }
        let dest = target(root, *directory, &path, directories)?;
        fs::create_dir(dest).map_err(|e| format!("创建目录失败（同名目录不会覆盖）：{e}"))?;
        directories.insert(path);
        Ok(())
    }
}

#[tauri::command]
pub async fn ssh_local_write(
    state: tauri::State<'_, LocalFiles>,
    window: tauri::Window,
    id: String,
    path: String,
    offset: u64,
    data: Vec<u8>,
    r#final: Option<bool>,
) -> Result<(), String> {
    if data.len() > CHUNK {
        return Err("写入分块过大".into());
    }
    let local = state.inner().clone();
    let owner = window.label().to_string();
    tokio::task::spawn_blocking(move || {
        local.write(&owner, &id, path, offset, data, r#final.unwrap_or(false))
    })
    .await
    .map_err(|e| e.to_string())?
}

impl LocalFiles {
    fn write(
        &self,
        owner: &str,
        id: &str,
        path: String,
        offset: u64,
        data: Vec<u8>,
        final_chunk: bool,
    ) -> Result<(), String> {
        if data.len() > CHUNK {
            return Err("写入分块过大".into());
        }
        let mut grants = self.0.lock().unwrap();
        let Access::Download {
            root,
            directory,
            directories,
            pending,
            completed,
        } = grant(&mut grants, id, owner)?
        else {
            return Err("所选位置不可写".into());
        };
        if completed.contains(&path) {
            return Err("文件已经完成".into());
        }
        if !pending.contains_key(&path) {
            if offset != 0 {
                return Err("文件分块顺序错误".into());
            }
            let dest = target(root, *directory, &path, directories)?;
            if *directory && fs::symlink_metadata(&dest).is_ok() {
                return Err("同名文件不会覆盖".into());
            }
            let temp = dest.with_file_name(format!(
                ".serial-studio-{}.part",
                NEXT_ID.fetch_add(1, Ordering::Relaxed)
            ));
            let file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temp)
                .map_err(|e| e.to_string())?;
            pending.insert(
                path.clone(),
                Pending {
                    file: Some(file),
                    temporary: temp,
                    target: dest,
                    offset: 0,
                },
            );
        }
        let p = pending.get_mut(&path).ok_or("下载已取消")?;
        if p.offset != offset {
            return Err("文件分块顺序错误".into());
        }
        p.file
            .as_mut()
            .ok_or("下载已关闭")?
            .write_all(&data)
            .map_err(|e| e.to_string())?;
        p.offset += data.len() as u64;
        if final_chunk {
            let mut p = pending.remove(&path).ok_or("下载已取消")?;
            p.file
                .as_ref()
                .ok_or("下载已关闭")?
                .sync_all()
                .map_err(|e| e.to_string())?;
            drop(p.file.take());
            if *directory && fs::symlink_metadata(&p.target).is_ok() {
                return Err("同名文件不会覆盖".into());
            }
            if *directory {
                // Linking publishes a completed file without replacing a concurrent destination.
                fs::hard_link(&p.temporary, &p.target).map_err(|e| e.to_string())?;
            } else {
                fs::rename(&p.temporary, &p.target).map_err(|e| e.to_string())?;
            }
            completed.insert(path);
        }
        Ok(())
    }
}

#[tauri::command]
pub fn ssh_local_release(state: tauri::State<'_, LocalFiles>, window: tauri::Window, id: String) {
    let mut grants = state.0.lock().unwrap();
    if grants.get(&id).is_some_and(|g| g.owner == window.label()) {
        grants.remove(&id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn relative_paths_cannot_escape_the_picker() {
        for path in ["", "../x", "/tmp/x", "a/../x", "C:/x", "a\\b", "./x"] {
            assert!(relative(path).is_err(), "{path}");
        }
        assert_eq!(
            relative("folder/file.txt").unwrap(),
            PathBuf::from("folder/file.txt")
        );
    }
    #[test]
    fn grants_are_scoped_to_the_window() {
        let local = LocalFiles::default();
        let id = local.insert("one".into(), Access::Upload(HashMap::new()));
        assert!(grant(&mut local.0.lock().unwrap(), &id, "two").is_err());
        local.release_window("one");
        assert!(local.0.lock().unwrap().is_empty());
    }

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "ss-local-files-{}-{}",
                std::process::id(),
                NEXT_ID.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&root).unwrap();
            Self(root)
        }
        fn download(&self, local: &LocalFiles, name: &str, directory: bool) -> String {
            local.insert(
                "one".into(),
                Access::Download {
                    root: self.0.join(name),
                    directory,
                    directories: HashSet::new(),
                    pending: HashMap::new(),
                    completed: HashSet::new(),
                },
            )
        }
        fn parts(&self) -> Vec<PathBuf> {
            fs::read_dir(&self.0)
                .unwrap()
                .map(|entry| entry.unwrap().path())
                .filter(|path| path.extension().is_some_and(|ext| ext == "part"))
                .collect()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    #[test]
    fn cancelling_download_closes_and_removes_temporary_without_touching_original() {
        let fixture = Fixture::new();
        let local = LocalFiles::default();
        let target = fixture.0.join("original.txt");
        fs::write(&target, b"original").unwrap();
        let id = fixture.download(&local, "original.txt", false);
        local
            .write("one", &id, "".into(), 0, b"partial".to_vec(), false)
            .unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"original");
        assert_eq!(fixture.parts().len(), 1);
        local.release_window("two");
        assert_eq!(fixture.parts().len(), 1);
        local.release_window("one");
        assert!(fixture.parts().is_empty());
        assert_eq!(fs::read(&target).unwrap(), b"original");
        assert!(local
            .write("one", &id, "".into(), 7, b"late".to_vec(), true)
            .is_err());
    }

    #[test]
    fn empty_and_multichunk_files_are_published_only_at_completion() {
        let fixture = Fixture::new();
        let local = LocalFiles::default();
        let empty = fixture.download(&local, "empty", false);
        local
            .write("one", &empty, "".into(), 0, vec![], true)
            .unwrap();
        assert_eq!(fs::metadata(fixture.0.join("empty")).unwrap().len(), 0);
        let id = fixture.download(&local, "output", false);
        let first = vec![0x5a; CHUNK];
        local
            .write("one", &id, "".into(), 0, first.clone(), false)
            .unwrap();
        assert!(!fixture.0.join("output").exists());
        assert!(local
            .write("one", &id, "".into(), 0, b"wrong offset".to_vec(), false)
            .is_err());
        local
            .write("one", &id, "".into(), CHUNK as u64, b"tail".to_vec(), true)
            .unwrap();
        let expected = [first, b"tail".to_vec()].concat();
        assert_eq!(fs::read(fixture.0.join("output")).unwrap(), expected);
        assert!(fixture.parts().is_empty());
        assert!(local.write("one", &id, "".into(), 0, vec![], true).is_err());
    }

    #[test]
    fn read_and_write_enforce_chunk_limits_and_picker_scope() {
        let fixture = Fixture::new();
        let local = LocalFiles::default();
        let source = fixture.0.join("source");
        let bytes: Vec<u8> = (0..CHUNK + 17).map(|n| (n % 251) as u8).collect();
        fs::write(&source, &bytes).unwrap();
        let id = local.insert(
            "one".into(),
            Access::Upload(HashMap::from([("source".into(), source)])),
        );
        assert_eq!(
            local.read("one", &id, "source", 0, CHUNK).unwrap(),
            bytes[..CHUNK]
        );
        assert_eq!(
            local
                .read("one", &id, "source", CHUNK as u64, CHUNK)
                .unwrap(),
            bytes[CHUNK..]
        );
        assert!(local.read("one", &id, "source", 0, CHUNK + 1).is_err());
        assert!(local.read("two", &id, "source", 0, 1).is_err());
        assert!(local.read("one", &id, "../source", 0, 1).is_err());
        assert!(local.read("one", &id, "unknown", 0, 1).is_err());
        assert!(local
            .read("one", &id, "source", bytes.len() as u64, CHUNK)
            .unwrap()
            .is_empty());
        let out = fixture.download(&local, "output", false);
        assert!(local
            .write("one", &out, "".into(), 0, vec![0; CHUNK + 1], true)
            .is_err());
        assert!(local
            .write("two", &out, "".into(), 0, vec![1], true)
            .is_err());
        assert!(local
            .write("one", &out, "other".into(), 0, vec![1], true)
            .is_err());
        assert!(!fixture.0.join("output").exists());
        assert!(fixture.parts().is_empty());
    }

    #[test]
    fn folder_download_preserves_existing_entries_and_rejects_escape() {
        let fixture = Fixture::new();
        let local = LocalFiles::default();
        let id = fixture.download(&local, "", true);
        fs::create_dir(fixture.0.join("existing")).unwrap();
        fs::write(fixture.0.join("original"), b"keep").unwrap();
        assert!(local.mkdir("one", &id, "existing".into()).is_err());
        assert!(local.mkdir("one", &id, "original".into()).is_err());
        assert!(local.mkdir("two", &id, "fresh".into()).is_err());
        assert!(local.mkdir("one", &id, "../escape".into()).is_err());
        assert!(local
            .write("one", &id, "original".into(), 0, b"replace".to_vec(), true)
            .is_err());
        assert!(local
            .write("one", &id, "../escape".into(), 0, vec![], true)
            .is_err());
        assert!(local
            .write("one", &id, "nested/file".into(), 0, vec![], true)
            .is_err());
        local.mkdir("one", &id, "nested".into()).unwrap();
        local.mkdir("one", &id, "nested/empty".into()).unwrap();
        local
            .write("one", &id, "nested/file".into(), 0, b"new".to_vec(), true)
            .unwrap();
        assert_eq!(fs::read(fixture.0.join("nested/file")).unwrap(), b"new");
        assert!(fixture.0.join("nested/empty").is_dir());
        assert_eq!(fs::read(fixture.0.join("original")).unwrap(), b"keep");
    }

    #[test]
    fn destination_created_during_transfer_is_not_replaced_for_folder_download() {
        let fixture = Fixture::new();
        let local = LocalFiles::default();
        let id = fixture.download(&local, "", true);
        local
            .write("one", &id, "raced".into(), 0, b"first".to_vec(), false)
            .unwrap();
        fs::write(fixture.0.join("raced"), b"other application").unwrap();
        assert!(local
            .write("one", &id, "raced".into(), 5, b"last".to_vec(), true)
            .is_err());
        assert_eq!(
            fs::read(fixture.0.join("raced")).unwrap(),
            b"other application"
        );
        assert!(fixture.parts().is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn replaced_destination_root_and_symlink_uploads_are_rejected() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        let local = LocalFiles::default();
        fs::create_dir(fixture.0.join("root")).unwrap();
        let id = fixture.download(&local, "root", true);
        fs::rename(fixture.0.join("root"), fixture.0.join("moved")).unwrap();
        symlink(fixture.0.join("moved"), fixture.0.join("root")).unwrap();
        assert!(local.mkdir("one", &id, "child".into()).is_err());
        assert!(local
            .write("one", &id, "file".into(), 0, vec![], true)
            .is_err());
        fs::write(fixture.0.join("source"), b"content").unwrap();
        symlink(fixture.0.join("source"), fixture.0.join("link")).unwrap();
        let upload = local.insert(
            "one".into(),
            Access::Upload(HashMap::from([("link".into(), fixture.0.join("link"))])),
        );
        assert!(local.read("one", &upload, "link", 0, 1).is_err());
        let mut entries = vec![];
        collect(
            &fixture.0.join("link"),
            "link".into(),
            &mut entries,
            &mut HashMap::new(),
        )
        .unwrap();
        assert!(entries.is_empty());
    }
    #[test]
    fn file_destination_cannot_replace_a_directory() {
        let fixture = Fixture::new();
        let local = LocalFiles::default();
        fs::create_dir(fixture.0.join("folder")).unwrap();
        let id = fixture.download(&local, "folder", false);
        assert!(local
            .write("one", &id, "".into(), 0, b"data".to_vec(), true)
            .is_err());
        assert!(fixture.0.join("folder").is_dir());
        assert!(fixture.parts().is_empty());
    }
    #[test]
    fn explicitly_selected_file_is_replaced_after_final_chunk() {
        let fixture = Fixture::new();
        let local = LocalFiles::default();
        let target = fixture.0.join("selected");
        fs::write(&target, b"old").unwrap();
        let id = fixture.download(&local, "selected", false);
        local
            .write("one", &id, "".into(), 0, b"new ".to_vec(), false)
            .unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"old");
        local
            .write("one", &id, "".into(), 4, b"content".to_vec(), true)
            .unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"new content");
        assert!(fixture.parts().is_empty());
    }
    #[test]
    fn upload_selection_cannot_mix_same_named_sources_or_excessive_depth() {
        let fixture = Fixture::new();
        let first = fixture.0.join("first");
        let second = fixture.0.join("second");
        fs::write(&first, b"first content").unwrap();
        fs::write(&second, b"second content").unwrap();
        let mut entries = Vec::new();
        let mut files = HashMap::new();
        collect(&first, "same.txt".into(), &mut entries, &mut files).unwrap();
        assert!(collect(&second, "same.txt".into(), &mut entries, &mut files).is_err());
        assert_eq!(
            fs::read(files.get("same.txt").unwrap()).unwrap(),
            b"first content"
        );
        assert!(collect(&second, vec!["dir"; 65].join("/"), &mut entries, &mut files).is_err());
    }
}
