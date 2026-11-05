//! Bridge layer for the Python backend: locate yhub → launch → readiness probe → health check →
//! logs → graceful shutdown.
//!
//! Decision (`docs/packaging.md`):
//! **do not bundle a Python runtime into the app**. The shell only finds the `yhub` the user already
//! installed (pip / uv tool / source tree) and launches it with `std::process::Command`; **the
//! transport is loopback HTTP on 127.0.0.1** (not stdio / socket IPC, not an embedded interpreter),
//! keeping port 8790 (changing it means changing three places: the CSP in `tauri.conf.json`,
//! `SECURITY_CSP` in `yhub/server/main.py`, and `getBaseUrl` in `web/src/api.ts`).
//!
//! Launch order ("prefer the installed backend"):
//!   1. the port already serves → **reuse** (a dev machine's resident `uv run yhub gui` keeps its
//!      behavior, and we never kill it on exit);
//!   2. the `yhub` binary explicitly given by `YHUB_BACKEND_BIN` (used by verification scripts; a
//!      wrong value is an error, never a silent fallback);
//!   3. installed `yhub`: PATH → `~/.local/bin/yhub` → Homebrew / `/usr/local/bin`;
//!   4. source-tree fallback: `uv run yhub` (repository development).
//!
//! Three engineering constraints:
//!   * **never hang**: launch has a timeout (20 s by default), HTTP calls have timeouts, and a child
//!     that dies during the readiness probe is abandoned immediately;
//!   * **never leak**: only the backend this process launched is shut down (SIGTERM → grace period →
//!     SIGKILL); a reused backend is never touched;
//!   * **traceable**: the child's stdout/stderr go in full to `~/.yhub/logs/backend.log`, and
//!     the bridge's own events to `desktop.log`; the UI can read the tail of both
//!     (`backend_log_tail`).
//!
//! Environment variables (all for verification scripts; production defaults are 8790 / 20 s /
//! ~/.yhub/logs):
//!   `YHUB_BACKEND_BIN`      the `yhub` binary to launch (a nonexistent / non-executable file is an
//!                           **explicit error**, never a silent fallback)
//!   `YHUB_BACKEND_PORT`     port override (tests / multiple instances only; production is 8790)
//!   `YHUB_BACKEND_TIMEOUT_MS` readiness wait limit
//!   `YHUB_LOG_DIR`          log directory override
//!   `YHUB_DEBUG_BACKEND_SELFTEST=1|timeout|badbin` unattended self-test (see `spawn_selftest`)

use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::AppHandle;

#[cfg(unix)]
use std::os::unix::process::CommandExt;

use crate::config;
use crate::i18n;

/// Production port: three hardcoded places (CSP / SECURITY_CSP / getBaseUrl) agree on it; do not change
pub const DEFAULT_PORT: u16 = 8790;

/// Minimum backend version the shell requires. Below it the UI must not pretend to be healthy (an
/// old backend may lack new endpoints).
pub const MIN_BACKEND_VERSION: &str = "0.1.7";

fn version_lt(version: &str, minimum: &str) -> bool {
    fn parts(v: &str) -> Vec<u32> {
        v.trim_start_matches('v')
            .split('.')
            .map(|p| p.parse::<u32>().unwrap_or(0))
            .collect()
    }
    let a = parts(version);
    let b = parts(minimum);
    for i in 0..a.len().max(b.len()) {
        let x = a.get(i).copied().unwrap_or(0);
        let y = b.get(i).copied().unwrap_or(0);
        if x != y {
            return x < y;
        }
    }
    false
}

const ENV_BACKEND_BIN: &str = "YHUB_BACKEND_BIN";
const ENV_PORT: &str = "YHUB_BACKEND_PORT";
const ENV_START_TIMEOUT_MS: &str = "YHUB_BACKEND_TIMEOUT_MS";
const ENV_LOG_DIR: &str = "YHUB_LOG_DIR";
const ENV_SELFTEST: &str = "YHUB_DEBUG_BACKEND_SELFTEST";

const DEFAULT_START_TIMEOUT_MS: u64 = 20_000;
const READY_POLL_MS: u64 = 200;
const CONNECT_TIMEOUT_MS: u64 = 400;
const HTTP_TIMEOUT_MS: u64 = 3_000;
const SHUTDOWN_GRACE_MS: u64 = 3_000;
/// Max response body per call (local loopback; normal responses are KB-sized)
const MAX_HTTP_BODY: usize = 4 << 20;
const MAX_LOG_BYTES: u64 = 4 << 20;

// ---------------------------------------------------------------- public structures

/// Where the backend came from: reused existing service / explicitly given / installed yhub / uv run
pub mod source {
    pub const REUSED: &str = "reused";
    /// The `yhub` explicitly given by `YHUB_BACKEND_BIN` (verification scripts / custom installs)
    pub const EXTERNAL: &str = "external";
    /// A `yhub` installed on the user's machine (PATH / ~/.local/bin / Homebrew)
    pub const INSTALLED: &str = "installed";
    /// Source-tree fallback: `uv run yhub`
    pub const UV_RUN: &str = "uv_run";
    pub const NONE: &str = "none";
}

/// Result of one probe/launch (UI, logs and verification scripts share this struct so none writes its own)
#[derive(Debug, Clone, Serialize)]
pub struct BackendStatus {
    pub port: u16,
    /// Something is listening on the port
    pub running: bool,
    /// `/api/health` call succeeded
    pub healthy: bool,
    /// See the `source` module
    pub source: String,
    /// Launched by this process (gracefully shut down on exit); always false for a reused backend
    pub owned: bool,
    pub pid: Option<u32>,
    /// The executable actually used (diagnostics)
    pub bin: Option<String>,
    pub version: Option<String>,
    /// Elapsed time of the most recent `/api/health` round trip
    pub latency_ms: Option<u64>,
    pub started_at: Option<u64>,
    /// Human-readable error (None when there is none)
    pub error: Option<String>,
    /// What to do about it
    pub hint: Option<String>,
    pub log_path: String,
}

/// Return value of the minimal connectivity case: really calls `/api/health` + `/api/tools`
#[derive(Debug, Clone, Serialize)]
pub struct BridgeHealth {
    pub ok: bool,
    pub port: u16,
    pub source: String,
    pub version: Option<String>,
    /// Number of tools returned by `/api/tools` (a real business endpoint, proving the bridge moves
    /// data rather than just shaking hands)
    pub tools: Option<usize>,
    pub latency_ms: u64,
    pub log_path: String,
    pub error: Option<String>,
    pub hint: Option<String>,
}

struct Owned {
    child: Child,
    source: &'static str,
    bin: PathBuf,
    port: u16,
    started_at: u64,
}

/// The backend launched by this process (the only place holding a Child; Drop does not shut it
/// down — shutdown is explicit on exit)
static OWNED: Mutex<Option<Owned>> = Mutex::new(None);
/// Most recent probe result: when nothing serves on the port, the UI shows "why it failed last time"
/// from it
static LAST: Mutex<Option<BackendStatus>> = Mutex::new(None);
/// Serialization lock for launching: the startup thread and the UI's first request may both demand
/// "ensure running"; without it each would launch one (the second necessarily fails because the port
/// is taken). Only one launch is allowed while the lock is held.
static STARTING: Mutex<()> = Mutex::new(());

// ---------------------------------------------------------------- environment and paths

fn env_nonempty(name: &str) -> Option<String> {
    let raw = std::env::var(name).ok()?;
    let trimmed = raw.trim().to_string();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

/// Port: `YHUB_BACKEND_PORT` > 8790
pub fn port() -> u16 {
    env_nonempty(ENV_PORT)
        .and_then(|v| v.parse::<u16>().ok())
        .unwrap_or(DEFAULT_PORT)
}

fn start_timeout() -> Duration {
    Duration::from_millis(
        env_nonempty(ENV_START_TIMEOUT_MS)
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(DEFAULT_START_TIMEOUT_MS),
    )
}

/// Log directory: `YHUB_LOG_DIR` > config dir (parent of `YHUB_CONFIG_DIR` / `YHUB_SETTINGS_FILE`) /logs.
/// Follows the same override rules as config, so verification scripts using a temp directory never
/// write logs into the real user directory.
pub fn log_dir() -> PathBuf {
    if let Some(dir) = env_nonempty(ENV_LOG_DIR) {
        return PathBuf::from(dir);
    }
    config::config_dir().join("logs")
}

pub fn desktop_log_path() -> PathBuf {
    log_dir().join("desktop.log")
}

pub fn backend_log_path() -> PathBuf {
    log_dir().join("backend.log")
}

/// pid of the backend launched by this app (also written to disk so install scripts can reap orphans
/// after the app is force-killed).
pub fn owned_pid_path() -> PathBuf {
    log_dir().join("backend.pid")
}

fn remember_owned_pid(pid: u32) {
    let path = owned_pid_path();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::write(path, pid.to_string());
}

/// Remove the pid file; when `expected` is given, delete only if the content matches (so a later
/// writer's record is not removed).
fn forget_owned_pid(expected: Option<u32>) {
    let path = owned_pid_path();
    if let Some(want) = expected {
        let current = fs::read_to_string(&path).ok();
        if current.as_deref().map(str::trim) != Some(want.to_string().as_str()) {
            return;
        }
    }
    let _ = fs::remove_file(path);
}

/// Append a line to the desktop log (also printed to stderr, so it is visible when launched from a
/// terminal)
pub fn log(msg: &str) {
    let line = format!("[{}] {msg}\n", timestamp());
    eprintln!("[backend] {msg}");
    let path = desktop_log_path();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    rotate_if_big(&path);
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&path) {
        let _ = file.write_all(line.as_bytes());
    }
}

/// Read the log tail (for UI/script troubleshooting). Only reads the last 256 KiB so large files do
/// not slow down the UI.
pub fn tail_log(kind: &str, lines: usize) -> String {
    let path = match kind {
        "backend" => backend_log_path(),
        _ => desktop_log_path(),
    };
    let raw = fs::read(&path).unwrap_or_default();
    let start = raw.len().saturating_sub(256 << 10);
    let text = String::from_utf8_lossy(&raw[start..]).to_string();
    let all: Vec<&str> = text.lines().collect();
    let skip = all.len().saturating_sub(lines.max(1));
    all[skip..].join("\n")
}

fn rotate_if_big(path: &Path) {
    let too_big = fs::metadata(path).map(|m| m.len() > MAX_LOG_BYTES).unwrap_or(false);
    if too_big {
        let rotated = path.with_file_name(format!(
            "{}.1",
            path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()
        ));
        let _ = fs::rename(path, rotated);
    }
}

/// Local timestamp (`2026-09-24T21:05:00`). Only so humans can read the logs, no dependency: read the
/// timezone offset once with `date +%z`, then compute the calendar from UTC+offset.
pub fn timestamp() -> String {
    static OFFSET: OnceLock<i64> = OnceLock::new();
    let offset = *OFFSET.get_or_init(|| {
        Command::new("date")
            .arg("+%z")
            .output()
            .ok()
            .and_then(|out| String::from_utf8(out.stdout).ok())
            .and_then(|s| parse_tz_offset(s.trim()))
            .unwrap_or(0)
    });
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    format_local(secs + offset)
}

fn parse_tz_offset(raw: &str) -> Option<i64> {
    let bytes = raw.as_bytes();
    if bytes.len() != 5 {
        return None;
    }
    let sign = match bytes[0] {
        b'+' => 1,
        b'-' => -1,
        _ => return None,
    };
    let hours: i64 = raw.get(1..3)?.parse().ok()?;
    let minutes: i64 = raw.get(3..5)?.parse().ok()?;
    Some(sign * (hours * 3600 + minutes * 60))
}

fn format_local(epoch: i64) -> String {
    let days = epoch.div_euclid(86_400);
    let rem = epoch.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

/// Days since 1970-01-01 → (year, month, day); Howard Hinnant's civil_from_days
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

// ---------------------------------------------------------------- HTTP client (zero dependencies)

#[derive(Debug, Clone)]
pub struct HttpResponse {
    pub status: u16,
    pub body: String,
}

/// Minimal HTTP/1.1 GET (just enough to call the local backend; no heavy dependency such as reqwest).
/// Sends `Connection: close`, so it can read until EOF; decodes chunked too.
pub fn http_get(port: u16, path: &str, timeout: Duration) -> Result<HttpResponse, String> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&addr, timeout)
        .map_err(|e| format!("连接 127.0.0.1:{port} 失败：{e}"))?;
    let _ = stream.set_read_timeout(Some(timeout));
    let _ = stream.set_write_timeout(Some(timeout));
    let request = format!(
        "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAccept: application/json\r\nConnection: close\r\n\r\n"
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|e| format!("发送请求失败：{e}"))?;

    let mut raw = Vec::new();
    let mut buf = [0u8; 8192];
    loop {
        match stream.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                raw.extend_from_slice(&buf[..n]);
                if raw.len() > MAX_HTTP_BODY {
                    return Err("响应体超过上限（后端返回了异常大的内容）".to_string());
                }
            }
            Err(e) => return Err(format!("读取响应失败：{e}")),
        }
    }
    parse_response(&raw)
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack.windows(needle.len()).position(|w| w == needle)
}

fn parse_response(raw: &[u8]) -> Result<HttpResponse, String> {
    let split = find_subslice(raw, b"\r\n\r\n")
        .ok_or_else(|| "响应不是合法 HTTP（找不到头部结束标记）".to_string())?;
    let head = String::from_utf8_lossy(&raw[..split]).to_string();
    let body = &raw[split + 4..];

    let status_line = head.lines().next().ok_or_else(|| "响应为空".to_string())?;
    let status: u16 = status_line
        .split_whitespace()
        .nth(1)
        .ok_or_else(|| format!("状态行无法解析：{status_line}"))?
        .parse()
        .map_err(|_| format!("状态码无法解析：{status_line}"))?;

    let chunked = head.to_ascii_lowercase().contains("transfer-encoding: chunked");
    let bytes = if chunked { decode_chunked(body)? } else { body.to_vec() };
    Ok(HttpResponse { status, body: String::from_utf8_lossy(&bytes).to_string() })
}

fn decode_chunked(mut data: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    loop {
        let nl = find_subslice(data, b"\r\n").ok_or_else(|| "chunked 响应缺少块长度行".to_string())?;
        let size_line = String::from_utf8_lossy(&data[..nl]).to_string();
        let size_hex = size_line.split(';').next().unwrap_or("").trim();
        let size = usize::from_str_radix(size_hex, 16)
            .map_err(|_| format!("块长度无法解析：{size_line}"))?;
        data = &data[nl + 2..];
        if size == 0 {
            break;
        }
        if data.len() < size {
            return Err("chunked 响应被截断".to_string());
        }
        out.extend_from_slice(&data[..size]);
        data = &data[size..];
        if data.starts_with(b"\r\n") {
            data = &data[2..];
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------- probing

/// Is anything listening on the port (does not check whether it is our backend)
pub fn probe(port: u16) -> bool {
    TcpStream::connect_timeout(
        &SocketAddr::from(([127, 0, 0, 1], port)),
        Duration::from_millis(CONNECT_TIMEOUT_MS),
    )
    .is_ok()
}

/// Call `/api/health`; on success return (version, round-trip milliseconds)
pub fn read_health(port: u16) -> Result<(String, u64), String> {
    let started = Instant::now();
    let res = http_get(port, "/api/health", Duration::from_millis(HTTP_TIMEOUT_MS))?;
    let latency = started.elapsed().as_millis() as u64;
    if res.status != 200 {
        return Err(format!("/api/health 返回 HTTP {}", res.status));
    }
    let json: serde_json::Value =
        serde_json::from_str(&res.body).map_err(|e| format!("/api/health 返回的不是 JSON：{e}"))?;
    let version = json
        .get("version")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    Ok((version, latency))
}

fn read_tool_count(port: u16) -> Result<usize, String> {
    let res = http_get(port, "/api/tools", Duration::from_millis(HTTP_TIMEOUT_MS))?;
    if res.status != 200 {
        return Err(format!("/api/tools 返回 HTTP {}", res.status));
    }
    let json: serde_json::Value =
        serde_json::from_str(&res.body).map_err(|e| format!("/api/tools 返回的不是 JSON：{e}"))?;
    json.get("tools")
        .and_then(|v| v.as_array())
        .map(|list| list.len())
        .ok_or_else(|| "/api/tools 响应里没有 tools 数组".to_string())
}

struct Ready {
    version: String,
    latency_ms: u64,
}

/// Wait for the backend to become ready: poll `/api/health`; abandon immediately if the child process
/// already exited (do not burn the full 20 seconds)
fn wait_ready(port: u16, timeout: Duration, mut child: Option<&mut Child>) -> Result<Ready, String> {
    let deadline = Instant::now() + timeout;
    let mut last_error = String::from("还没有响应");
    loop {
        if let Some(proc) = child.as_deref_mut() {
            if let Ok(Some(status)) = proc.try_wait() {
                return Err(format!("后端进程已退出（{status}），看日志找堆栈"));
            }
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "等待后端就绪超时（{} ms）：{last_error}",
                timeout.as_millis()
            ));
        }
        match read_health(port) {
            Ok((version, latency_ms)) => return Ok(Ready { version, latency_ms }),
            Err(e) => last_error = e,
        }
        std::thread::sleep(Duration::from_millis(READY_POLL_MS));
    }
}

// ---------------------------------------------------------------- artifact resolution

fn is_executable_file(path: &Path) -> bool {
    let Ok(meta) = fs::metadata(path) else { return false };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

struct Plan {
    bin: PathBuf,
    args: Vec<String>,
    source: &'static str,
}

fn gui_args(port: u16) -> Vec<String> {
    vec!["gui".to_string(), "--no-open".to_string(), "--port".to_string(), port.to_string()]
}

/// Find `yhub` in PATH and the common install directories.
///
/// Why not `which`: a GUI app (launched by Finder/launchd) has a PATH of only
/// `/usr/bin:/bin:/usr/sbin:/sbin`; `main.rs` already extends PATH, but this adds another layer so
/// "works in a terminal, not from the icon" does not happen. The order is fixed, so the result is predictable.
fn installed_candidates() -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    if let Ok(path) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path) {
            out.push(dir.join("yhub"));
        }
    }
    if let Some(home) = dirs::home_dir() {
        out.push(home.join(".local/bin/yhub"));
    }
    for dir in ["/opt/homebrew/bin", "/usr/local/bin"] {
        out.push(PathBuf::from(dir).join("yhub"));
    }
    out
}

/// Decide which executable to launch this round.
/// When `YHUB_BACKEND_BIN` is set there is **no fallback**: a wrong value is an error, so a script
/// cannot believe it tests the installed backend while it actually tests the source tree.
fn resolve_plan(_app: Option<&AppHandle>, port: u16) -> Result<Plan, (String, String)> {
    if let Some(raw) = env_nonempty(ENV_BACKEND_BIN) {
        let bin = PathBuf::from(&raw);
        if !bin.exists() {
            return Err((
                i18n::trf("backend.bin_missing", &[("env", ENV_BACKEND_BIN), ("path", &raw)]),
                i18n::tr("backend.bin_missing_hint").to_string(),
            ));
        }
        if !is_executable_file(&bin) {
            return Err((
                i18n::trf("backend.bin_not_executable", &[("env", ENV_BACKEND_BIN), ("path", &raw)]),
                i18n::trf("backend.bin_not_executable_hint", &[("path", &raw)]),
            ));
        }
        return Ok(Plan { bin, args: gui_args(port), source: source::EXTERNAL });
    }

    for candidate in installed_candidates() {
        if is_executable_file(&candidate) {
            return Ok(Plan { bin: candidate, args: gui_args(port), source: source::INSTALLED });
        }
    }

    // Source-tree fallback: still runs from the repository when no yhub is installed (cwd switches to
    // the repository root)
    Ok(Plan {
        bin: PathBuf::from("uv"),
        args: {
            let mut args = vec!["run".to_string(), "yhub".to_string()];
            args.extend(gui_args(port));
            args
        },
        source: source::UV_RUN,
    })
}

fn spawn_with_log(plan: &Plan, port: u16, log_path: &Path) -> std::io::Result<Child> {
    if let Some(parent) = log_path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    rotate_if_big(log_path);
    let file = OpenOptions::new().create(true).append(true).open(log_path)?;
    let header = format!(
        "\n===== [{}] 拉起后端：{} {} (source={}, port={}) =====\n",
        timestamp(),
        plan.bin.display(),
        plan.args.join(" "),
        plan.source,
        port
    );
    let mut handle = file;
    let _ = handle.write_all(header.as_bytes());

    // Working directory: the source-tree fallback (uv run) must stand at the project root, otherwise uv
    // cannot find pyproject.toml; an installed yhub does not care, so HOME is used uniformly there to
    // avoid depending on the caller's cwd.
    let cwd = match plan.source {
        source::UV_RUN => PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .map(|repo| repo.to_path_buf())
            .or_else(dirs::home_dir)
            .unwrap_or_else(|| PathBuf::from("/")),
        _ => dirs::home_dir().unwrap_or_else(|| PathBuf::from("/")),
    };

    let mut command = Command::new(&plan.bin);
    command
        .args(&plan.args)
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        // Do not let Python buffer stderr — logs must be usable for live troubleshooting
        .env("PYTHONUNBUFFERED", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::from(handle.try_clone()?))
        .stderr(Stdio::from(handle))
        .current_dir(cwd);
    #[cfg(unix)]
    {
        // Make the backend its own process-group leader: wrappers such as `uv run` fork the real
        // backend, so signaling only the direct child leaves an orphan holding the port (seen in
        // practice). Once the group exists, terminate() can signal the whole group (-pid).
        command.process_group(0);
    }
    command.spawn()
}

// ---------------------------------------------------------------- shutdown

/// Signal the whole process group (`kill -TERM -- -<pgid>`). The group is created by `spawn_with_log`
/// (leader = the direct child).
#[cfg(unix)]
fn signal_group(signal: &str, pid: u32) -> std::io::Result<std::process::ExitStatus> {
    Command::new("kill").arg(signal).arg(format!("-{pid}")).status()
}

/// Hard-kill the whole group (the self-test uses it to simulate "the backend crashed"; normal shutdown
/// goes through `terminate`)
#[cfg(unix)]
fn kill_group_hard(pid: u32) {
    let _ = signal_group("-9", pid);
}

#[cfg(not(unix))]
fn kill_group_hard(_pid: u32) {}

/// Graceful shutdown: SIGTERM → grace period → SIGKILL. Returns a human-readable description (written
/// to the log).
///
/// The signal goes to the **whole process group** (negative pid): the backend starts in its own group
/// (see `spawn_with_log`), so two-layer structures such as "`uv run` wrapper + real process" are
/// collected together.
fn terminate(child: &mut Child, grace: Duration, port: Option<u16>) -> String {
    let pid = child.id();
    #[cfg(unix)]
    {
        let _ = signal_group("-TERM", pid);
    }
    #[cfg(not(unix))]
    {
        let _ = child.kill();
        let _ = port;
        return "已请求退出".to_string();
    }

    let mut notes: Vec<String> = Vec::new();
    let started = Instant::now();
    let mut exited = false;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => {
                exited = true;
                break;
            }
            Ok(None) => {}
            Err(e) => {
                notes.push(format!("等待退出失败：{e}"));
                break;
            }
        }
        if started.elapsed() >= grace {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }

    if exited {
        notes.push(format!("SIGTERM 后 {} ms 内退出", started.elapsed().as_millis()));
    } else {
        match child.kill() {
            Ok(()) => {
                let _ = child.wait();
                notes.push(format!("SIGTERM 在 {} ms 内没生效，已强杀", grace.as_millis()));
            }
            Err(e) => notes.push(format!("强杀失败：{e}")),
        }
    }

    // Fallback: if a listener is still on the port, collect it by port. When the source tree is launched
    // via `uv run`, the actual listener is the wrapper's grandchild and sits in its own process group
    // (measured: the group id is unrelated to the shell's pid), so signaling the group we created misses
    // it and leaves an orphan holding 8790.
    if let Some(port) = port {
        if let Some(note) = sweep_port(port, grace) {
            notes.push(note);
        }
    }
    notes.join("；")
}

/// Collect the listening process on a local port (SIGTERM → grace → SIGKILL).
/// Returns a human-readable note; None when nothing was listening on the port.
#[cfg(unix)]
fn sweep_port(port: u16, grace: Duration) -> Option<String> {
    let pids = listeners_on_port(port);
    if pids.is_empty() {
        return None;
    }
    for pid in &pids {
        let _ = Command::new("kill").arg("-TERM").arg(pid.to_string()).status();
    }
    let started = Instant::now();
    while started.elapsed() < grace {
        if listeners_on_port(port).is_empty() {
            return Some(format!("端口 {port} 上残留的监听进程已退出（pid {pids:?}）"));
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    for pid in &pids {
        let _ = Command::new("kill").arg("-9").arg(pid.to_string()).status();
    }
    Some(format!("端口 {port} 上的监听进程 SIGTERM 未生效，已强杀（pid {pids:?}）"))
}

#[cfg(not(unix))]
fn sweep_port(_port: u16, _grace: Duration) -> Option<String> {
    None
}

/// Who is listening on a local port (`lsof -t`; empty when unavailable, never panics)
fn listeners_on_port(port: u16) -> Vec<u32> {
    let out = Command::new("lsof")
        .args(["-nP", &format!("-iTCP:{port}"), "-sTCP:LISTEN", "-t"])
        .output();
    match out {
        Ok(out) => String::from_utf8_lossy(&out.stdout)
            .split_whitespace()
            .filter_map(|s| s.parse::<u32>().ok())
            .collect(),
        Err(_) => Vec::new(),
    }
}

/// Shut down the backend this process launched (called on app exit or when close_behavior=quit).
/// **Only shuts down what we launched**: a reused backend (a dev machine's resident
/// `uv run yhub gui`) is never touched.
pub fn shutdown(reason: &str) -> String {
    let mut guard = match OWNED.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };
    let Some(owned) = guard.as_mut() else {
        let msg = format!("没有本进程拉起的后端，跳过（{reason}）");
        log(&msg);
        return msg;
    };
    let pid = owned.child.id();
    let bin = owned.bin.display().to_string();
    let port = owned.port;
    let how = terminate(&mut owned.child, Duration::from_millis(SHUTDOWN_GRACE_MS), Some(port));
    let msg = format!("已关闭自启后端 pid={pid}（{bin}）：{how}（{reason}）");
    log(&msg);
    forget_owned_pid(Some(pid));
    *guard = None;
    msg
}

/// pid of the backend this process launched (for self-tests / verification scripts)
pub fn owned_pid() -> Option<u32> {
    OWNED.lock().ok().and_then(|g| g.as_ref().map(|o| o.child.id()))
}

fn owned_meta(port: u16) -> Option<(&'static str, u64)> {
    let guard = OWNED.lock().ok()?;
    guard
        .as_ref()
        .filter(|o| o.port == port)
        .map(|o| (o.source, o.started_at))
}

/// Drop the record of a launched backend that has already died (so a zombie is not mistaken for
/// "we are still running")
fn reap_dead_owned() {
    let Ok(mut guard) = OWNED.lock() else { return };
    let dead = matches!(guard.as_mut().map(|o| o.child.try_wait()), Some(Ok(Some(_))));
    if dead {
        if let Some(pid) = guard.as_ref().map(|o| o.child.id()) {
            forget_owned_pid(Some(pid));
        }
        *guard = None;
    }
}

// ---------------------------------------------------------------- status and launching

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn remember(status: &BackendStatus) {
    if let Ok(mut guard) = LAST.lock() {
        *guard = Some(status.clone());
    }
}

fn log_hint() -> String {
    i18n::trf(
        "backend.log_hint",
        &[("path", &backend_log_path().display().to_string())],
    )
}

fn idle_status(port: u16, error: Option<String>, hint: Option<String>) -> BackendStatus {
    BackendStatus {
        port,
        running: false,
        healthy: false,
        source: source::NONE.to_string(),
        owned: false,
        pid: None,
        bin: None,
        version: None,
        latency_ms: None,
        started_at: None,
        error,
        hint,
        log_path: backend_log_path().display().to_string(),
    }
}

/// Probe only, never launch: used by the UI to show status when it opens
pub fn status(_app: Option<&AppHandle>) -> BackendStatus {
    let port = port();
    reap_dead_owned();
    if !probe(port) {
        // Nothing on the port: surface "why it failed last time" honestly (the UI must see the reason)
        let previous = LAST.lock().ok().and_then(|g| g.clone());
        let (error, hint) = match previous {
            Some(prev) if prev.error.is_some() => (prev.error, prev.hint),
            _ => (None, None),
        };
        let status = idle_status(port, error, hint);
        return status;
    }

    let (healthy, version, latency_ms, error) = match read_health(port) {
        Ok((version, latency)) if version_lt(&version, MIN_BACKEND_VERSION) => (
            false,
            Some(version.clone()),
            Some(latency),
            Some(format!(
                "后端版本过旧（{version} < {MIN_BACKEND_VERSION}）：升级 `yhub` 后点「重新检测」"
            )),
        ),
        Ok((version, latency)) => (true, Some(version), Some(latency), None),
        Err(e) => (false, None, None, Some(format!("端口在听但 /api/health 调用失败：{e}"))),
    };
    let owned = owned_meta(port);
    let status = BackendStatus {
        port,
        running: true,
        healthy,
        source: owned.map(|(source, _)| source).unwrap_or(source::REUSED).to_string(),
        owned: owned.is_some(),
        pid: owned_pid(),
        bin: None,
        version,
        latency_ms,
        started_at: owned.map(|(_, started_at)| started_at),
        error,
        hint: None,
        log_path: backend_log_path().display().to_string(),
    };
    status
}

/// Launch on demand (reuse if already running). This is the bridge's core entry point: the returned
/// struct carries human-readable errors and hints.
pub fn ensure_running(app: Option<&AppHandle>) -> BackendStatus {
    let port = port();
    reap_dead_owned();

    // 1) Already serving → reuse (a resident dev-machine backend keeps its behavior and is not killed
    //    on exit)
    if probe(port) {
        let status = status(app);
        remember(&status);
        return status;
    }

    // 2) Serialize "launching": the main-thread startup and the UI's first request may both demand
    //    "ensure running". Probe again after taking the lock — if the previous call just started the
    //    backend, reuse it; otherwise both would launch one and the second would necessarily fail
    //    because the port is taken (seen in practice).
    let _gate = STARTING.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if probe(port) {
        let status = status(app);
        remember(&status);
        return status;
    }

    // 3) Decide which artifact to use
    let plan = match resolve_plan(app, port) {
        Ok(plan) => plan,
        Err((error, hint)) => {
            let status = idle_status(port, Some(error.clone()), Some(hint.clone()));
            log(&format!("拉起后端失败：{error}｜{hint}"));
            remember(&status);
            return status;
        }
    };

    log(&format!(
        "拉起后端：{} {} (source={}, port={port})",
        plan.bin.display(),
        plan.args.join(" "),
        plan.source
    ));

    let log_path = backend_log_path();
    let mut child = match spawn_with_log(&plan, port, &log_path) {
        Ok(child) => child,
        Err(e) => {
            let error = i18n::trf(
                "backend.start_failed",
                &[("bin", &plan.bin.display().to_string()), ("error", &e.to_string())],
            );
            let hint = if plan.source == source::UV_RUN {
                i18n::trf("backend.not_installed_hint", &[("log", &log_hint())])
            } else {
                log_hint()
            };
            let status = idle_status(port, Some(error.clone()), Some(hint.clone()));
            log(&format!("{error}｜{hint}"));
            remember(&status);
            return status;
        }
    };
    let pid = child.id();
    // Persist first: exit hooks do not run when the app is SIGKILLed/force-quit, and install scripts
    // reap orphan backends from this file.
    remember_owned_pid(pid);

    // Wait for readiness (timeout / early child exit both count as failure; on failure clean up the
    // process just launched so no orphan is left)
    match wait_ready(port, start_timeout(), Some(&mut child)) {
        Ok(ready) => {
            log(&format!(
                "后端就绪：pid={pid} source={} version={} 首次响应 {} ms",
                plan.source, ready.version, ready.latency_ms
            ));
            let started_at = now_secs();
            let too_old = version_lt(&ready.version, MIN_BACKEND_VERSION);
            if let Ok(mut guard) = OWNED.lock() {
                *guard = Some(Owned {
                    child,
                    source: plan.source,
                    bin: plan.bin.clone(),
                    port,
                    started_at,
                });
            }
            let status = BackendStatus {
                port,
                running: true,
                healthy: !too_old,
                source: plan.source.to_string(),
                owned: true,
                pid: Some(pid),
                bin: Some(plan.bin.display().to_string()),
                version: Some(ready.version.clone()),
                latency_ms: Some(ready.latency_ms),
                started_at: Some(started_at),
                error: too_old.then(|| {
                    i18n::trf(
                        "backend.version_too_old",
                        &[("version", &ready.version), ("min", MIN_BACKEND_VERSION)],
                    )
                }),
                hint: too_old.then(|| i18n::tr("backend.upgrade_hint").to_string()),
                log_path: log_path.display().to_string(),
            };
            remember(&status);
            status
        }
        Err(e) => {
            let how = terminate(&mut child, Duration::from_millis(SHUTDOWN_GRACE_MS), Some(port));
            forget_owned_pid(Some(pid));
            let error = i18n::trf(
                "backend.not_ready",
                &[("ms", &start_timeout().as_millis().to_string()), ("error", &e.to_string())],
            );
            let hint = i18n::trf("backend.cleanup_hint", &[("how", &how), ("log", &log_hint())]);
            log(&format!("{error}｜{hint}"));
            let status = idle_status(port, Some(error), Some(hint));
            remember(&status);
            status
        }
    }
}

/// Minimal connectivity case: make sure the backend runs, then **really call** `/api/health` and
/// `/api/tools`. The UI's "re-check", verification scripts and self-tests all go through this one, so
/// they test the same path.
pub fn health(app: Option<&AppHandle>) -> BridgeHealth {
    let status = ensure_running(app);
    let port = status.port;
    if !status.running {
        return BridgeHealth {
            ok: false,
            port,
            source: status.source,
            version: None,
            tools: None,
            latency_ms: 0,
            log_path: status.log_path,
            error: status.error.or_else(|| Some(i18n::tr("backend.not_running").to_string())),
            hint: status.hint,
        };
    }
    match read_health(port) {
        Ok((version, latency_ms)) => BridgeHealth {
            ok: true,
            port,
            source: status.source,
            version: Some(version),
            tools: read_tool_count(port).ok(),
            latency_ms,
            log_path: status.log_path,
            error: None,
            hint: None,
        },
        Err(e) => BridgeHealth {
            ok: false,
            port,
            source: status.source,
            version: None,
            tools: None,
            latency_ms: 0,
            log_path: status.log_path,
            error: Some(i18n::trf("backend.health_failed", &[("error", &e.to_string())])),
            hint: Some(log_hint()),
        },
    }
}

// ---------------------------------------------------------------- self-test

/// Unattended self-test (`YHUB_DEBUG_BACKEND_SELFTEST=1|timeout|badbin`): goes through exactly the path
/// the UI's "re-check" button uses (ensure_running / health / status / shutdown).
pub fn spawn_selftest(app: AppHandle) {
    let mode = std::env::var(ENV_SELFTEST).unwrap_or_else(|_| "1".to_string());
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(1500));
        let mut failures: Vec<String> = Vec::new();
        eprintln!("[selftest] start mode={mode} port={}", port());

        match mode.as_str() {
            "timeout" => selftest_timeout(&mut failures),
            "badbin" => selftest_badbin(&mut failures),
            _ => selftest_happy(&app, &mut failures),
        }

        eprintln!("[selftest] done failures={}", failures.len());
        app.exit(if failures.is_empty() { 0 } else { 1 });
    });
}

fn check(failures: &mut Vec<String>, name: &str, got: bool, want: bool) {
    let verdict = if got == want { "OK" } else { "FAIL" };
    eprintln!("[selftest] {name}: got={got} want={want} {verdict}");
    if got != want {
        failures.push(name.to_string());
    }
}

fn selftest_happy(app: &AppHandle, failures: &mut Vec<String>) {
    let started = Instant::now();
    let st = ensure_running(Some(app));
    eprintln!(
        "[selftest] ensure_running: running={} healthy={} source={} owned={} pid={:?} bin={:?} elapsed={}ms",
        st.running,
        st.healthy,
        st.source,
        st.owned,
        st.pid,
        st.bin,
        started.elapsed().as_millis()
    );
    check(failures, "ensure_running 拉起并探活成功", st.running && st.healthy, true);
    check(failures, "status 报告运行中", status(Some(app)).running, true);

    // Minimal connectivity case: real endpoints (the version comes from the backend, not a local constant)
    let report = health(Some(app));
    eprintln!(
        "[selftest] health: ok={} version={:?} tools={:?} latency={}ms source={}",
        report.ok, report.version, report.tools, report.latency_ms, report.source
    );
    check(failures, "health 通过 /api/health 拿到版本号", report.ok && report.version.is_some(), true);
    check(
        failures,
        "真实业务接口 /api/tools 拿到工具清单",
        report.tools.unwrap_or(0) > 0,
        true,
    );

    // Never hang: calling a nonexistent path must still return in bounded time (the backend returns
    // 404, it does not hang)
    let probe_started = Instant::now();
    let bogus = http_get(port(), "/api/__no_such_path__", Duration::from_millis(HTTP_TIMEOUT_MS));
    eprintln!(
        "[selftest] 404 探针：{:?} 耗时 {} ms",
        bogus.as_ref().map(|r| r.status),
        probe_started.elapsed().as_millis()
    );
    check(
        failures,
        "调用不存在的接口有界返回（不卡死）",
        probe_started.elapsed() < Duration::from_secs(6),
        true,
    );

    if !st.owned {
        eprintln!("[selftest] 端口上是别人拉起的后端（source=reused）：跳过崩溃自愈与关闭相位");
        return;
    }

    // Crash self-healing: SIGKILL the backend we launched; the next call must launch it again
    let Some(pid) = owned_pid() else {
        check(failures, "自启后端有 pid", false, true);
        return;
    };
    // Simulate "the backend crashed": hard-kill the whole group and then sweep any listener left on the
    // port (wrappers such as `uv run` put the real backend into their own process group, so killing only
    // the wrapper is not a crash).
    kill_group_hard(pid);
    let _ = sweep_port(port(), Duration::from_millis(500));
    std::thread::sleep(Duration::from_millis(200));
    check(failures, "后端被杀后端口不再监听", !probe(port()), true);
    let revived = health(Some(app));
    eprintln!(
        "[selftest] 崩溃自愈：ok={} version={:?} source={} error={:?}",
        revived.ok, revived.version, revived.source, revived.error
    );
    check(failures, "崩溃后下一次调用自动重新拉起（自愈）", revived.ok, true);

    // Graceful shutdown: only the one we launched; the port must be released afterwards
    let report = shutdown("selftest");
    eprintln!("[selftest] shutdown: {report}");
    check(failures, "关闭后端口已释放", !probe(port()), true);
}

fn selftest_timeout(failures: &mut Vec<String>) {
    let started = Instant::now();
    let st = ensure_running(None);
    let elapsed = started.elapsed();
    eprintln!(
        "[selftest] ensure_running(timeout 用例): running={} error={:?} elapsed={}ms",
        st.running,
        st.error,
        elapsed.as_millis()
    );
    check(failures, "拉不起后端时不假装成功", st.running, false);
    check(
        failures,
        "失败信息说清了原因（超时/进程早退）",
        st.error
            .as_deref()
            .map(|e| e.contains("就绪") || e.contains("已退出"))
            .unwrap_or(false),
        true,
    );
    check(
        failures,
        "失败信息带日志路径（可定位）",
        st.hint
            .as_deref()
            .map(|h| h.contains("backend.log"))
            .unwrap_or(false),
        true,
    );
    check(
        failures,
        "失败后不留监听进程（端口空着）",
        !probe(port()),
        true,
    );
    // After a failure the app must stay usable: asking for status again must return a bounded,
    // human-readable result instead of hanging
    let after = status(None);
    eprintln!("[selftest] 失败后 status: running={} error={:?}", after.running, after.error);
    check(failures, "失败后状态查询仍有界返回", !after.running && after.error.is_some(), true);
}

fn selftest_badbin(failures: &mut Vec<String>) {
    let status = ensure_running(None);
    eprintln!(
        "[selftest] ensure_running(badbin 用例): running={} error={:?} hint={:?}",
        status.running, status.error, status.hint
    );
    check(failures, "环境变量写错时不假装成功", status.running, false);
    check(
        failures,
        "错误里带上写错的路径",
        status
            .error
            .as_deref()
            .map(|e| e.contains("YHUB_BACKEND_BIN"))
            .unwrap_or(false),
        true,
    );
    check(
        failures,
        "错误里有怎么办（hint）",
        status.hint.is_some(),
        true,
    );
}

// ---------------------------------------------------------------- unit tests

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_status_and_body() {
        let raw = b"HTTP/1.1 200 OK\r\nContent-Length: 12\r\nContent-Type: application/json\r\n\r\n{\"ok\":true}";
        let res = parse_response(raw).expect("解析失败");
        assert_eq!(res.status, 200);
        assert_eq!(res.body, "{\"ok\":true}");
    }

    #[test]
    fn parses_chunked_body() {
        // The two chunks concatenate to {"ok":true} (chunk lengths must match the content byte count,
        // otherwise an extra CR is swallowed)
        let raw = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\n{\"ok\"\r\n6\r\n:true}\r\n0\r\n\r\n";
        let res = parse_response(raw).expect("解析失败");
        assert_eq!(res.body, "{\"ok\":true}");
    }

    #[test]
    fn rejects_garbage() {
        assert!(parse_response(b"not http at all").is_err());
        assert!(parse_response(b"HTTP/1.1 OK OK\r\n\r\n").is_err());
    }

    #[test]
    fn detects_old_backend_versions() {
        assert!(version_lt("0.0.9", MIN_BACKEND_VERSION));
        assert!(version_lt("0.0.99", MIN_BACKEND_VERSION));
        assert!(!version_lt(MIN_BACKEND_VERSION, MIN_BACKEND_VERSION));
        // The floor moves with each release that adds a capability plugins or the shell depend on
        // (0.1.1 = plugins carry their own translations), so derive the "one release below" case
        // from the constant instead of pinning a literal that goes stale on the next bump.
        let mut parts: Vec<u32> = MIN_BACKEND_VERSION.split('.').map(|p| p.parse().unwrap()).collect();
        while let Some(last) = parts.last_mut() {
            if *last > 0 {
                *last -= 1;
                break;
            }
            parts.pop();
        }
        let below = parts.iter().map(|p| p.to_string()).collect::<Vec<_>>().join(".");
        assert!(version_lt(&format!("v{below}"), MIN_BACKEND_VERSION), "{below} should count as old");
        assert!(!version_lt(&format!("v{MIN_BACKEND_VERSION}"), MIN_BACKEND_VERSION));
    }

    #[test]
    fn formats_local_time() {
        // 1970-01-01T00:00:00 and 1790330096 = 2026-09-25T09:54:56Z (verified with `date -u -r`)
        assert_eq!(format_local(0), "1970-01-01T00:00:00");
        assert_eq!(format_local(1_790_330_096), "2026-09-25T09:54:56");
    }

    #[test]
    fn parses_timezone_offset() {
        assert_eq!(parse_tz_offset("+0800"), Some(8 * 3600));
        assert_eq!(parse_tz_offset("-0530"), Some(-(5 * 3600 + 1800)));
        assert_eq!(parse_tz_offset("bogus"), None);
    }

    #[test]
    fn env_backend_bin_without_fallback() {
        // A nonexistent path must be an error (do not silently fall back to the global CLI, or
        // verification scripts would test the wrong target)
        let err = resolve_plan(None, 8790).err();
        if let Some(raw) = env_nonempty(ENV_BACKEND_BIN) {
            if !Path::new(&raw).exists() {
                let (message, hint) = err.expect("应当报错");
                assert!(message.contains(ENV_BACKEND_BIN));
                assert!(!hint.is_empty());
            }
        } else {
            let plan = resolve_plan(None, 8790).expect("应当给出一个方案");
            assert!(!plan.args.is_empty());
            assert!(["installed", "uv_run"].contains(&plan.source));
        }
    }

    #[test]
    fn http_client_talks_to_a_stub_server() {
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let handle = std::thread::spawn(move || {
            for _ in 0..3 {
                let Ok((mut stream, _)) = listener.accept() else { return };
                let mut buf = [0u8; 1024];
                let _ = stream.read(&mut buf);
                let body = "{\"ok\":true,\"version\":\"stub\"}";
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = stream.write_all(response.as_bytes());
            }
        });

        assert!(probe(port));
        let (version, _latency) = read_health(port).expect("health 应当成功");
        assert_eq!(version, "stub");
        let res = http_get(port, "/api/tools", Duration::from_secs(2)).expect("tools 应当成功");
        assert_eq!(res.status, 200);
        let _ = handle.join();
    }

    #[test]
    fn wait_ready_gives_up_on_dead_child() {
        // Must give up immediately once the child has exited, instead of burning the full timeout
        let mut child = Command::new("sleep").arg("0.05").spawn().expect("spawn sleep");
        std::thread::sleep(Duration::from_millis(300));
        let started = Instant::now();
        let result = wait_ready(6553, Duration::from_secs(10), Some(&mut child));
        assert!(result.is_err(), "应当报错");
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "应当立刻放弃，实际 {:?}",
            started.elapsed()
        );
        let _ = child.wait();
    }

    #[test]
    fn terminate_kills_the_whole_process_group() {
        // Wrappers such as `uv run` fork the real backend: killing only the direct child leaves an
        // orphan holding the port. The backend starts in its own process group (spawn_with_log), and
        // shutdown signals the whole group.
        let mut command = Command::new("sh");
        command.arg("-c").arg("sleep 60 & sleep 60");
        #[cfg(unix)]
        command.process_group(0);
        let mut child = command.spawn().expect("spawn sh");
        let pgid = child.id();
        std::thread::sleep(Duration::from_millis(400));

        let before = group_members(pgid);
        assert!(
            before.len() >= 2,
            "进程组里应当有壳 + 后台子进程，实际 {before:?}"
        );

        let how = terminate(&mut child, Duration::from_millis(2_000), None);
        assert!(!how.is_empty());
        let _ = child.wait();

        let after = group_members(pgid);
        assert!(after.is_empty(), "关闭后进程组里不该有残留：{after:?}");
    }

    /// Members of a process group (filter `ps -A -o pid=,pgid=` ourselves; do not rely on ps's -g semantics)
    #[cfg(unix)]
    fn group_members(pgid: u32) -> Vec<u32> {
        let out = match Command::new("ps").args(["-A", "-o", "pid=,pgid="]).output() {
            Ok(out) => out,
            Err(_) => return Vec::new(),
        };
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .filter_map(|line| {
                let mut parts = line.split_whitespace();
                let pid: u32 = parts.next()?.parse().ok()?;
                let group: u32 = parts.next()?.parse().ok()?;
                (group == pgid).then_some(pid)
            })
            .collect()
    }

    #[cfg(not(unix))]
    fn group_members(_pgid: u32) -> Vec<u32> {
        Vec::new()
    }

    #[test]
    fn sweep_clears_a_listener_in_another_group() {
        // Simulate `uv run`: the wrapper puts the real backend into **another** process group (measured:
        // the group id is unrelated to the wrapper's pid), so signaling by group misses it and the port
        // fallback in terminate is required.
        if Command::new("python3").arg("-V").output().is_err() {
            eprintln!("没有 python3，跳过该用例");
            return;
        }
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();
        drop(listener); // release the port to the child process

        let script = r#"
import os, socket, subprocess, sys, time
port = int(sys.argv[1])
code = ("import os,socket,time\n"
        "os.setpgid(0, 0)\n"
        "s = socket.socket()\n"
        "s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)\n"
        "s.bind(('127.0.0.1', %d))\n"
        "s.listen(1)\n"
        "time.sleep(60)\n") % port
subprocess.Popen([sys.executable, "-c", code], preexec_fn=os.setpgrp)
time.sleep(60)
"#;
        let mut command = Command::new("python3");
        command.arg("-c").arg(script).arg(port.to_string());
        #[cfg(unix)]
        command.process_group(0);
        let mut child = command.spawn().expect("spawn python3");

        let deadline = Instant::now() + Duration::from_secs(10);
        while listeners_on_port(port).is_empty() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(
            !listeners_on_port(port).is_empty(),
            "模拟的监听进程没起来（端口 {port}）"
        );

        let how = terminate(&mut child, Duration::from_millis(2_000), Some(port));
        assert!(how.contains("端口"), "说明里应当提到端口兜底：{how}");
        assert!(
            listeners_on_port(port).is_empty(),
            "端口 {port} 上还有残留监听进程"
        );
    }

    #[test]
    fn tail_log_reads_last_lines() {
        let dir = std::env::temp_dir().join(format!("yhub-backend-test-{}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        let file = dir.join("desktop.log");
        fs::write(&file, "a\nb\nc\n").expect("write");
        let raw = fs::read(&file).expect("read");
        let text = String::from_utf8_lossy(&raw).to_string();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines[lines.len() - 1], "c");
        let _ = fs::remove_dir_all(&dir);
    }
}
