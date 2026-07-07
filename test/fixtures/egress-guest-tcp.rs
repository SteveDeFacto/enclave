// Minimal wasip2 guest: connect out via std (→ wasi:sockets), send a probe,
// print the reply. Used to prove enclave transparent egress routes an UNMODIFIED
// app's raw outbound through the dedicated-IP tunnel (and that with the network
// locked down a direct/loopback dial is refused).
use std::io::{Read, Write};
use std::net::TcpStream;

fn main() {
    let target = std::env::var("TARGET").unwrap_or_else(|_| "93.184.216.34:80".into());
    match TcpStream::connect(&target) {
        Ok(mut s) => {
            let _ = s.write_all(b"ping-egress");
            let mut buf = [0u8; 128];
            match s.read(&mut buf) {
                Ok(n) => println!("OK {}", String::from_utf8_lossy(&buf[..n])),
                Err(e) => println!("READERR {e}"),
            }
        }
        Err(e) => println!("CONNERR {e}"),
    }
}
