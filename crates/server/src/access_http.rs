use crate::access::VerifyError;
use crate::{AppState, PortView};
use axum::extract::{ConnectInfo, Extension, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::json;
use std::net::SocketAddr;

#[derive(Clone, Copy)]
pub(crate) struct SecureTransport;

fn cookie_name(state: &AppState, secure: bool) -> String {
    if secure {
        "__Host-serial_studio_access".into()
    } else {
        // Cookies are shared by all ports on a host, including independent instances.
        let id: String = state
            .instance_id
            .bytes()
            .filter(u8::is_ascii_alphanumeric)
            .map(char::from)
            .collect();
        format!("serial_studio_access_{id}")
    }
}

fn session_cookie(state: &AppState, secure: bool, value: &str, extra: &str) -> String {
    let name = cookie_name(state, secure);
    let secure_flag = if secure { "; Secure" } else { "" };
    format!("{name}={value}; HttpOnly; SameSite=Strict; Path=/{secure_flag}{extra}")
}

#[derive(Clone)]
pub(crate) struct Grant {
    pub(crate) token: Option<String>,
    pub(crate) revision: u64,
    secure: bool,
}

impl Grant {
    pub(crate) fn new(state: &AppState, secure: bool, headers: &HeaderMap) -> Self {
        let revision = state.access.revision();
        let token = if state.access.config().allows_verification(secure) {
            let cookie_name = cookie_name(state, secure);
            headers
                .get(header::AUTHORIZATION)
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.strip_prefix("Bearer "))
                .or_else(|| {
                    headers
                        .get(header::COOKIE)?
                        .to_str()
                        .ok()?
                        .split(';')
                        .filter_map(|entry| entry.trim().split_once('='))
                        .find_map(|(name, value)| (name == cookie_name).then_some(value))
                })
                .filter(|v| v.len() == 64 && v.bytes().all(|c| c.is_ascii_hexdigit()))
                .filter(|token| state.access.validate(token, false, secure))
                .map(str::to_owned)
        } else {
            None
        };
        Self {
            token,
            revision,
            secure,
        }
    }

    pub(crate) fn authenticated(&self, state: &AppState, touch: bool) -> bool {
        self.token
            .as_deref()
            .is_some_and(|token| state.access.validate(token, touch, self.secure))
    }

    pub(crate) fn current(&self, state: &AppState) -> bool {
        self.revision == state.access.revision()
            && (self.token.is_none() || self.authenticated(state, false))
    }
}

pub(crate) fn origin_allowed(headers: &HeaderMap, secure: bool) -> bool {
    let Some(origin) = headers.get(header::ORIGIN) else {
        return true;
    };
    let Some(host) = headers.get(header::HOST).and_then(|v| v.to_str().ok()) else {
        return false;
    };
    let scheme = if secure { "https" } else { "http" };
    origin
        .to_str()
        .ok()
        .is_some_and(|o| o.eq_ignore_ascii_case(&format!("{scheme}://{host}")))
}

pub(crate) fn local_only(state: &AppState, canonical: &str) -> bool {
    let (device, _) = ss_core::split_port_key(canonical);
    state.devices.is_private(device)
}

pub(crate) fn restricted(state: &AppState, canonical: &str) -> bool {
    state.access.protects(canonical) || local_only(state, canonical)
}

pub(crate) fn blocked_port(state: &AppState, grant: &Grant, canonical: &str) -> bool {
    if local_only(state, canonical) {
        return true;
    }
    let config = state.access.config();
    if !config.enabled {
        return false;
    }
    if config.protects(canonical) && !grant.authenticated(state, false) {
        return true;
    }
    let (device, name) = ss_core::split_port_key(canonical);
    // Avoid opening alternate OS device paths that bypass the configured port identity.
    if device == ss_core::LOCAL_DEVICE_ID {
        if !ss_core::serial::list_port_names().iter().any(|p| p == name) {
            return true;
        }
    } else if !state.ssh.has_host(device) && !state.devices.has_port(canonical) {
        return true;
    }
    false
}

pub(crate) async fn visible_ports(
    state: &AppState,
    grant: &Grant,
    show_locked: bool,
) -> Vec<PortView> {
    let config = state.access.config();
    let authenticated = grant.authenticated(state, false);
    let mut ports = crate::list_ports_with_meta(state).await;
    ports.retain_mut(|port| {
        if local_only(state, &port.info.name) {
            return false;
        }
        if !config.protects(&port.info.name) || authenticated {
            return true;
        }
        if !show_locked {
            return false;
        }
        port.locked = Some(true);
        port.access_tls_port = config.https_available().then_some(config.tls_port);
        port.info.opened = false;
        port.info.holders = 0;
        port.info.disconnected = false;
        true
    });
    if grant.current(state) {
        ports
    } else {
        Vec::new()
    }
}

pub(crate) async fn status(
    State(state): State<AppState>,
    secure: Option<Extension<SecureTransport>>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let config = state.access.config();
    let grant = Grant::new(&state, secure.is_some(), &headers);
    (
        [(header::CACHE_CONTROL, "no-store")],
        Json(json!({
            "enabled": config.enabled,
            "allow_http": config.allow_http,
            "https_available": config.https_available(),
            "scope": config.scope,
            "tls_port": config.tls_port,
            "authenticated": grant.authenticated(&state, false)
        })),
    )
}

#[derive(Deserialize)]
pub(crate) struct Verify {
    code: String,
}

pub(crate) async fn verify(
    State(state): State<AppState>,
    secure: Option<Extension<SecureTransport>>,
    peer: Option<ConnectInfo<SocketAddr>>,
    headers: HeaderMap,
    Json(input): Json<Verify>,
) -> Response {
    let secure = secure.is_some();
    let Some(ConnectInfo(peer)) = peer.filter(|_| origin_allowed(&headers, secure)) else {
        return StatusCode::FORBIDDEN.into_response();
    };
    if !state.access.config().allows_verification(secure) {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({"error": "目标设备未允许通过此协议验证"})),
        )
            .into_response();
    }
    match state.access.verify(input.code.trim(), peer.ip(), secure) {
        Ok(token) => {
            let cookie = session_cookie(&state, secure, &token, "");
            (
                [
                    (header::SET_COOKIE, cookie),
                    (header::CACHE_CONTROL, "no-store".into()),
                ],
                Json(json!({"authenticated": true})),
            )
                .into_response()
        }
        Err(error) => {
            let status = match error {
                VerifyError::RateLimited => StatusCode::TOO_MANY_REQUESTS,
                VerifyError::Capacity => StatusCode::SERVICE_UNAVAILABLE,
                VerifyError::Disabled => StatusCode::FORBIDDEN,
                VerifyError::InvalidCode => StatusCode::UNAUTHORIZED,
            };
            (
                status,
                [(header::CACHE_CONTROL, "no-store")],
                Json(json!({"error": error.to_string()})),
            )
                .into_response()
        }
    }
}

pub(crate) async fn logout(
    State(state): State<AppState>,
    secure: Option<Extension<SecureTransport>>,
    headers: HeaderMap,
) -> Response {
    let secure = secure.is_some();
    if !state.access.config().allows_verification(secure) || !origin_allowed(&headers, secure) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let grant = Grant::new(&state, secure, &headers);
    if grant.authenticated(&state, false) {
        if let Some(token) = grant.token {
            state.access.revoke(&token);
        }
    }
    (
        StatusCode::NO_CONTENT,
        [(
            header::SET_COOKIE,
            session_cookie(&state, secure, "", "; Max-Age=0"),
        )],
    )
        .into_response()
}

pub(crate) async fn mcp(State(state): State<AppState>, body: String) -> Response {
    if state.access.blocked_all() {
        return StatusCode::FORBIDDEN.into_response();
    }
    let mut policy = state.access.subscribe();
    let revision = *policy.borrow_and_update();
    if state.access.blocked_all() {
        return StatusCode::FORBIDDEN.into_response();
    }
    let result = tokio::select! {
        biased;
        _ = policy.wait_for(|r| *r != revision) => return StatusCode::FORBIDDEN.into_response(),
        result = crate::mcp::handle_request(&body, &state) => result,
    };
    Json(result).into_response()
}
