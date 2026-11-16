use serde::Serialize;
use ss_server::supervisor::{ServiceStatus, ServiceSupervisor};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, SocketAddrV4};
use std::sync::Arc;

#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct ShareAddress {
    host: String,
    port: u16,
}

fn usable_ipv4(ip: &Ipv4Addr) -> bool {
    ip.octets()[0] != 0
        && ip.octets()[0] < 224
        && !ip.is_loopback()
        && !ip.is_link_local()
        && !ip.is_documentation()
}

fn sorted_hosts(hosts: impl IntoIterator<Item = Ipv4Addr>) -> Vec<Ipv4Addr> {
    let mut hosts: Vec<_> = hosts.into_iter().filter(usable_ipv4).collect();
    hosts.sort_unstable_by_key(|ip| (!ip.is_private(), *ip));
    hosts.dedup();
    hosts
}

fn local_hosts() -> Result<Vec<Ipv4Addr>, String> {
    let interfaces = if_addrs::get_if_addrs().map_err(|e| format!("无法读取本机网络地址：{e}"))?;
    Ok(sorted_hosts(interfaces.into_iter().filter_map(
        |interface| {
            if !interface.is_oper_up() {
                return None;
            }
            match interface.ip() {
                IpAddr::V4(ip) => Some(ip),
                IpAddr::V6(_) => None,
            }
        },
    )))
}

fn listening_address(status: &ServiceStatus) -> Result<SocketAddrV4, String> {
    if !status.running {
        return Err("服务尚未运行，请先在设置中启动服务".into());
    }
    let address = status
        .ws_addr
        .as_deref()
        .and_then(|value| value.parse::<SocketAddr>().ok())
        .ok_or("无法识别服务监听地址，请在设置中使用 IPv4 地址")?;
    let SocketAddr::V4(address) = address else {
        return Err("当前服务使用 IPv6 监听，请在设置中使用 IPv4 地址后分享".into());
    };
    if address.port() == 0 {
        return Err("无法识别服务端口，请在设置中使用固定端口".into());
    }
    if !address.ip().is_unspecified() && !usable_ipv4(address.ip()) {
        return Err(
            "当前服务仅监听本机或不可分享地址，请在设置中改为局域网 IPv4 地址或 0.0.0.0".into(),
        );
    }
    Ok(address)
}

fn share_addresses(
    address: SocketAddrV4,
    hosts: Vec<Ipv4Addr>,
) -> Result<Vec<ShareAddress>, String> {
    let hosts = if address.ip().is_unspecified() {
        sorted_hosts(hosts)
    } else {
        vec![*address.ip()]
    };
    if hosts.is_empty() {
        return Err("未找到可分享的局域网 IPv4 地址，请检查网络连接".into());
    }
    Ok(hosts
        .into_iter()
        .map(|host| ShareAddress {
            host: host.to_string(),
            port: address.port(),
        })
        .collect())
}

#[tauri::command]
pub async fn get_share_addresses(
    supervisor: tauri::State<'_, Arc<ServiceSupervisor>>,
) -> Result<Vec<ShareAddress>, String> {
    let address = listening_address(&supervisor.status().await)?;
    tauri::async_runtime::spawn_blocking(move || {
        let hosts = if address.ip().is_unspecified() {
            local_hosts()?
        } else {
            Vec::new()
        };
        share_addresses(address, hosts)
    })
    .await
    .map_err(|e| format!("读取分享地址失败：{e}"))?
}

#[tauri::command]
pub async fn get_local_share_hosts() -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        local_hosts().map(|hosts| hosts.into_iter().map(|ip| ip.to_string()).collect())
    })
    .await
    .map_err(|e| format!("读取本机地址失败：{e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(value: &str) -> Ipv4Addr {
        value.parse().unwrap()
    }

    fn status(address: Option<&str>) -> ServiceStatus {
        ServiceStatus {
            running: address.is_some(),
            ws_addr: address.map(str::to_string),
            telnet_addr: None,
        }
    }

    #[test]
    fn filters_unshareable_hosts_and_prioritizes_private_addresses() {
        let hosts = sorted_hosts(
            [
                "8.8.8.8",
                "192.168.1.4",
                "10.0.0.3",
                "192.168.1.4",
                "127.0.0.1",
                "0.1.2.3",
                "169.254.1.2",
                "224.0.0.1",
                "255.255.255.255",
                "240.0.0.1",
                "192.0.2.1",
            ]
            .map(ip),
        );
        assert_eq!(hosts, [ip("10.0.0.3"), ip("192.168.1.4"), ip("8.8.8.8")]);
    }

    #[test]
    fn wildcard_listening_offers_all_hosts_using_the_running_port() {
        let address = listening_address(&status(Some("0.0.0.0:19999"))).unwrap();
        let result = share_addresses(address, vec![ip("192.168.1.4"), ip("10.0.0.3")]).unwrap();
        assert_eq!(
            result,
            vec![
                ShareAddress {
                    host: "10.0.0.3".into(),
                    port: 19999
                },
                ShareAddress {
                    host: "192.168.1.4".into(),
                    port: 19999
                },
            ]
        );
        assert!(share_addresses(address, Vec::new()).is_err());
    }

    #[test]
    fn explicit_ipv4_binding_uses_only_the_bound_address() {
        let address = listening_address(&status(Some("192.168.1.4:18700"))).unwrap();
        assert_eq!(
            share_addresses(address, vec![ip("10.0.0.3")]).unwrap(),
            vec![ShareAddress {
                host: "192.168.1.4".into(),
                port: 18700
            },]
        );
    }

    #[test]
    fn rejects_stopped_loopback_ipv6_and_invalid_listeners() {
        assert!(listening_address(&status(None)).is_err());
        for value in [
            "127.0.0.1:18700",
            "[::]:18700",
            "[::1]:18700",
            "localhost:18700",
            "0.0.0.0:0",
            "invalid",
        ] {
            assert!(listening_address(&status(Some(value))).is_err(), "{value}");
        }
    }
}
