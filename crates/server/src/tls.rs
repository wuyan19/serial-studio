use axum::{extract::ConnectInfo, Extension, Router};
use hyper::server::conn::http1;
use hyper_util::{
    rt::{TokioIo, TokioTimer},
    service::TowerToHyperService,
};
use std::{sync::Arc, time::Duration};
use tokio::{
    net::TcpListener,
    sync::{oneshot, watch, Semaphore},
    task::JoinSet,
    time::timeout,
};
use tokio_rustls::{
    rustls::{
        self,
        pki_types::{pem::PemObject, CertificateDer, PrivateKeyDer},
    },
    TlsAcceptor,
};

use crate::access::AccessConfig;

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
const HEADER_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_HANDSHAKES: usize = 64;

pub(super) fn acceptor(config: &AccessConfig) -> Result<TlsAcceptor, String> {
    let certs = CertificateDer::pem_file_iter(&config.tls_cert)
        .and_then(|certs| certs.collect::<Result<Vec<_>, _>>())
        .map_err(|e| format!("读取 HTTPS 证书失败：{e}"))?;
    let key = PrivateKeyDer::from_pem_file(&config.tls_key)
        .map_err(|e| format!("读取 HTTPS 私钥失败：{e}"))?;
    let mut config = rustls::ServerConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .map_err(|e| format!("HTTPS 协议配置无效：{e}"))?
    .with_no_client_auth()
    .with_single_cert(certs, key)
    .map_err(|e| format!("HTTPS 证书与私钥配置无效：{e}"))?;
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok(TlsAcceptor::from(Arc::new(config)))
}

pub(super) async fn serve(
    listener: TcpListener,
    acceptor: watch::Receiver<TlsAcceptor>,
    app: Router,
    mut shutdown: oneshot::Receiver<()>,
) {
    let handshakes = Arc::new(Semaphore::new(MAX_HANDSHAKES));
    let mut connections = JoinSet::new();
    loop {
        tokio::select! {
            biased;
            _ = &mut shutdown => break,
            _ = connections.join_next(), if !connections.is_empty() => {},
            incoming = listener.accept() => {
                let (stream, peer) = match incoming {
                    Ok(connection) => connection,
                    Err(e) => {
                        tracing::warn!("HTTPS accept failed: {e}");
                        tokio::time::sleep(Duration::from_millis(100)).await;
                        continue;
                    }
                };
                let Ok(permit) = Arc::clone(&handshakes).try_acquire_owned() else {
                    continue;
                };
                let acceptor = acceptor.borrow().clone();
                let app = app.clone();
                connections.spawn(async move {
                    let result = timeout(HANDSHAKE_TIMEOUT, acceptor.accept(stream)).await;
                    drop(permit);
                    let Ok(Ok(stream)) = result else {
                        return;
                    };
                    let service = TowerToHyperService::new(app.layer(Extension(ConnectInfo(peer))));
                    if let Err(e) = http1::Builder::new()
                        .timer(TokioTimer::new())
                        .header_read_timeout(HEADER_TIMEOUT)
                        .serve_connection(TokioIo::new(stream), service)
                        .with_upgrades()
                        .await
                    {
                        tracing::debug!("HTTPS connection closed: {e}");
                    }
                });
            }
        }
    }
    drop(listener);
    connections.shutdown().await;
}
