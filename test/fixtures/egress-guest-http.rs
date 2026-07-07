// serve-mode wasip2 guest: on each request, make an OUTBOUND wasi:http GET to
// http://$TARGET/ and echo the status + first bytes. Proves enclave transparent
// egress routes wasi:http outgoing requests through the dedicated-IP tunnel.
use wasi::http::types::{
    Fields, Headers, IncomingRequest, Method, OutgoingRequest, OutgoingResponse, ResponseOutparam,
    Scheme,
};

wasi::http::proxy::export!(Guest);
struct Guest;

impl wasi::exports::http::incoming_handler::Guest for Guest {
    fn handle(_req: IncomingRequest, out: ResponseOutparam) {
        let body = fetch().unwrap_or_else(|e| format!("FETCHERR {e}"));
        let resp = OutgoingResponse::new(Fields::new());
        let ob = resp.body().unwrap();
        ResponseOutparam::set(out, Ok(resp));
        let os = ob.write().unwrap();
        os.blocking_write_and_flush(body.as_bytes()).ok();
        drop(os);
        wasi::http::types::OutgoingBody::finish(ob, None).ok();
    }
}

fn fetch() -> Result<String, String> {
    let target = std::env::var("TARGET").map_err(|_| "no TARGET".to_string())?;
    let (host, port) = target.rsplit_once(':').ok_or("bad TARGET")?;
    let req = OutgoingRequest::new(Headers::new());
    req.set_method(&Method::Get).map_err(|_| "method")?;
    req.set_scheme(Some(&Scheme::Http)).map_err(|_| "scheme")?;
    req.set_authority(Some(&target)).map_err(|_| "authority")?;
    req.set_path_with_query(Some("/")).map_err(|_| "path")?;
    let _ = (host, port);
    let fut = wasi::http::outgoing_handler::handle(req, None).map_err(|e| format!("handle {e:?}"))?;
    fut.subscribe().block();
    let resp = fut
        .get()
        .ok_or("no response")?
        .map_err(|_| "response taken")?
        .map_err(|e| format!("errcode {e:?}"))?;
    let status = resp.status();
    let ib = resp.consume().map_err(|_| "consume")?;
    let stream = ib.stream().map_err(|_| "stream")?;
    stream.subscribe().block();
    let bytes = stream.blocking_read(64).unwrap_or_default();
    Ok(format!("HTTP {status} {}", String::from_utf8_lossy(&bytes)))
}
