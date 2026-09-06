use axum::{
    extract::{ConnectInfo, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use std::{net::SocketAddr, time::Instant};

use crate::AppState;

type HmacSha256 = Hmac<Sha256>;

#[derive(Deserialize)]
pub struct PasskeyReq {
    pub passkey: String,
}

#[derive(Serialize)]
struct TokenHeader {
    alg: String,
    typ: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct TokenPayload {
    pub sub: String,
    pub iat: u64,
    pub exp: u64,
    #[serde(default)]
    pub role: Option<String>,
}

#[derive(Serialize)]
pub struct SessionStatusResponse {
    pub authenticated: bool,
    pub role: &'static str,
}

/// Verifies HMAC signature, decoding, and expiration of a JWT token string.
pub fn verify_token(token: &str, auth_secret: &str) -> Result<TokenPayload, &'static str> {
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() != 3 {
        return Err("Malformed token");
    }

    let msg = format!("{}.{}", parts[0], parts[1]);
    let mut mac = HmacSha256::new_from_slice(auth_secret.as_bytes())
        .map_err(|_| "HMAC init failed")?;
    mac.update(msg.as_bytes());
    let expected_sig = mac.finalize().into_bytes();
    let expected_sig_b64 = URL_SAFE_NO_PAD.encode(expected_sig);

    if parts[2].len() != expected_sig_b64.len()
        || !bool::from(subtle::ConstantTimeEq::ct_eq(parts[2].as_bytes(), expected_sig_b64.as_bytes()))
    {
        return Err("Invalid token signature");
    }

    let payload_bytes = URL_SAFE_NO_PAD
        .decode(parts[1])
        .map_err(|_| "Invalid token payload encoding")?;
    let payload: TokenPayload = serde_json::from_slice(&payload_bytes)
        .map_err(|_| "Invalid token payload format")?;

    let now = shared_domain::now_ist().timestamp() as u64;
    if now > payload.exp {
        return Err("Token expired");
    }

    Ok(payload)
}

/// `GET /api/auth/session` — returns current authentication status and role.
pub async fn session_status_handler(
    headers: axum::http::HeaderMap,
) -> impl IntoResponse {
    let auth_header = headers.get(axum::http::header::AUTHORIZATION)
        .and_then(|val| val.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "));

    let token = match auth_header {
        Some(t) => t,
        None => {
            return Json(SessionStatusResponse {
                authenticated: false,
                role: "read",
            });
        }
    };

    let auth_secret = match crate::resolve_auth_secret() {
        Some(s) => s,
        None => {
            return Json(SessionStatusResponse {
                authenticated: false,
                role: "read",
            });
        }
    };

    match verify_token(token, &auth_secret) {
        Ok(_) => Json(SessionStatusResponse {
            authenticated: true,
            role: "write",
        }),
        Err(_) => Json(SessionStatusResponse {
            authenticated: false,
            role: "read",
        }),
    }
}

pub async fn verify_passkey_handler(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    State(state): State<AppState>,
    Json(req): Json<PasskeyReq>,
) -> impl IntoResponse {
    let ip = addr.ip().to_string();

    // 1. Rate-limit check (5 attempts / 15 minutes)
    let window_duration = std::time::Duration::from_secs(15 * 60);
    let current_attempts;
    
    if let Some(mut entry) = state.rate_limit_map.get_mut(&ip) {
        if entry.window_start.elapsed() > window_duration {
            entry.attempts = 1;
            entry.window_start = Instant::now();
            current_attempts = 1;
        } else {
            if entry.attempts >= 5 {
                tracing::warn!(ip = %ip, "Rate limit exceeded for passkey login");
                return (
                    StatusCode::TOO_MANY_REQUESTS,
                    [("Retry-After", "900")],
                    Json(serde_json::json!({"error": "Too many attempts. Try again later."})),
                )
                    .into_response();
            }
            entry.attempts += 1;
            current_attempts = entry.attempts;
        }
    } else {
        state.rate_limit_map.insert(
            ip.clone(),
            crate::RateLimitEntry {
                attempts: 1,
                window_start: Instant::now(),
            },
        );
        current_attempts = 1;
    }

    // 2. Verify passkey (support both runtime and compile-time env vars)
    let env_passkey = std::env::var("PASSKEY")
        .or_else(|_| option_env!("PASSKEY").map(String::from).ok_or("not set"))
        .expect("PASSKEY must be set");
    
    // Constant-time comparison (check length first to prevent panic)
    let is_valid: bool = if req.passkey.len() == env_passkey.len() {
        subtle::ConstantTimeEq::ct_eq(req.passkey.as_bytes(), env_passkey.as_bytes()).into()
    } else {
        tracing::warn!(
            ip = %ip,
            req_len = req.passkey.len(),
            env_len = env_passkey.len(),
            "Passkey length mismatch"
        );
        false
    };

    if !is_valid {
        tracing::warn!(ip = %ip, attempts = current_attempts, "Invalid passkey attempt");
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({"error": "Invalid passkey"})),
        )
            .into_response();
    }

    // Reset rate limit on success
    state.rate_limit_map.remove(&ip);

    // 3. Issue Token
    let auth_secret = crate::resolve_auth_secret().expect("AUTH_SECRET must be set");
    let now = shared_domain::now_ist().timestamp() as u64;
    let exp = now + 7 * 24 * 60 * 60; // 7 days

    let header = TokenHeader {
        alg: "HS256".to_string(),
        typ: "AT".to_string(),
    };
    let payload = TokenPayload {
        sub: "trader".to_string(),
        iat: now,
        exp,
        role: Some("write".to_string()),
    };

    let header_b64 = URL_SAFE_NO_PAD.encode(serde_json::to_string(&header).unwrap());
    let payload_b64 = URL_SAFE_NO_PAD.encode(serde_json::to_string(&payload).unwrap());
    let msg = format!("{}.{}", header_b64, payload_b64);

    let mut mac = HmacSha256::new_from_slice(auth_secret.as_bytes()).expect("HMAC can take key of any size");
    mac.update(msg.as_bytes());
    let sig = mac.finalize().into_bytes();
    let sig_b64 = URL_SAFE_NO_PAD.encode(sig);

    let token = format!("{}.{}", msg, sig_b64);

    tracing::info!(ip = %ip, "Successful passkey login");
    (
        StatusCode::OK,
        Json(serde_json::json!({ "token": token })),
    ).into_response()
}
