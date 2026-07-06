// wasip2 guest that uses the PHASE-1 explicit path while running under the
// PHASE-2 lockdown: dial the NAN_EGRESS front directly (the shim must pass a
// dial to the front itself through), speak SOCKS5 (RFC 1928/1929), CONNECT to
// $TARGET as a DOMAIN (socks5h), print the BND.ADDR (= this deployment's
// derived source) and the tunneled echo reply. Proves "two ways in, one front"
// survives the lockdown.
use std::io::{Read, Write};
use std::net::TcpStream;

fn main() {
    match run() {
        Ok(line) => println!("{line}"),
        Err(e) => println!("SOCKSERR {e}"),
    }
}

fn run() -> Result<String, String> {
    let url = std::env::var("NAN_EGRESS").map_err(|_| "no NAN_EGRESS")?;
    let target = std::env::var("TARGET").unwrap_or_else(|_| "egress.test:80".into());
    let rest = url.split_once("://").map(|(_, r)| r).ok_or("bad url")?;
    let (creds, front) = rest.rsplit_once('@').ok_or("no creds")?;
    let (id, token) = creds.split_once(':').ok_or("bad creds")?;
    let (host, port) = target.rsplit_once(':').ok_or("bad TARGET")?;
    let port: u16 = port.parse().map_err(|_| "bad port")?;

    let mut s = TcpStream::connect(front).map_err(|e| format!("front dial: {e}"))?;
    s.write_all(&[0x05, 0x01, 0x02]).map_err(|e| e.to_string())?;
    let mut m = [0u8; 2];
    s.read_exact(&mut m).map_err(|e| e.to_string())?;
    if m != [0x05, 0x02] {
        return Err("no user/pass method".into());
    }
    let mut auth = vec![0x01, id.len() as u8];
    auth.extend_from_slice(id.as_bytes());
    auth.push(token.len() as u8);
    auth.extend_from_slice(token.as_bytes());
    s.write_all(&auth).map_err(|e| e.to_string())?;
    let mut a = [0u8; 2];
    s.read_exact(&mut a).map_err(|e| e.to_string())?;
    if a[1] != 0x00 {
        return Err("auth rejected".into());
    }
    let mut req = vec![0x05, 0x01, 0x00, 0x03, host.len() as u8];
    req.extend_from_slice(host.as_bytes());
    req.extend_from_slice(&port.to_be_bytes());
    s.write_all(&req).map_err(|e| e.to_string())?;
    let mut head = [0u8; 4];
    s.read_exact(&mut head).map_err(|e| e.to_string())?;
    if head[1] != 0x00 {
        return Err(format!("connect rep={}", head[1]));
    }
    let bnd = match head[3] {
        0x04 => {
            let mut b = [0u8; 18];
            s.read_exact(&mut b).map_err(|e| e.to_string())?;
            let mut g = [0u16; 8];
            for (i, w) in g.iter_mut().enumerate() {
                *w = u16::from_be_bytes([b[i * 2], b[i * 2 + 1]]);
            }
            std::net::Ipv6Addr::from(g).to_string()
        }
        0x01 => {
            let mut b = [0u8; 6];
            s.read_exact(&mut b).map_err(|e| e.to_string())?;
            format!("{}.{}.{}.{}", b[0], b[1], b[2], b[3])
        }
        t => return Err(format!("bnd atyp {t}")),
    };
    s.write_all(b"ping-egress").map_err(|e| e.to_string())?;
    let mut buf = [0u8; 128];
    let n = s.read(&mut buf).map_err(|e| e.to_string())?;
    Ok(format!("OK {bnd} {}", String::from_utf8_lossy(&buf[..n])))
}
