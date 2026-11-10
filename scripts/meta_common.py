"""Small, secret-safe Meta transport and private operation journal. Stdlib only."""
from __future__ import annotations

import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import tempfile
import unicodedata
import urllib.error
import urllib.parse
import urllib.request

API_VERSION = "v21.0"
TOKEN_PATH = "/srv/safetyradar/.secrets/meta_token"
STATE_DIR = "/srv/safetyradar/social/state"
ACCOUNT_ID = "1873587530725467"
ADSET_ID = "52544779664276"
CAMPAIGN_ID = "52544779549276"
IG_USER_ID = "17841441257076577"
AD_IG_USER_ID = "17841429970165089"  # Existing ads use this Page-backed identity, not the organic IG account.
PAGE_ID = "1338804342660007"
DESTINATION = "https://safetyradar.ch/de/"


class OperationError(Exception):
    """A safe-to-print operational error, never a raw HTTP exception."""


class MetaAPIError(OperationError):
    def __init__(self, message, *, code=None, status=None, api_message=None,
                 fbtrace_id=None, error_type=None, subcode=None):
        super().__init__(message)
        self.code = code
        self.status = status
        self.api_message = api_message
        self.fbtrace_id = fbtrace_id
        self.error_type = error_type
        self.subcode = subcode



_TOKENISH = re.compile(
    r"(?i)(?:access_token|token|bearer)[=: ]+\S{8,}|EAA[A-Za-z0-9]+|[A-Za-z0-9_-]{40,}"
)
_BLOCKED = re.compile(r"api access blocked", re.I)
_FBTRACE = re.compile(r"^[A-Za-z0-9+/=_-]{1,128}$")


def sanitize_meta_text(text, *, token=None):
    """Return a short, secret-safe copy of a Meta error string, or None."""
    if not isinstance(text, str):
        return None
    cleaned = text.replace("\x00", "")[:500]
    if token:
        cleaned = cleaned.replace(token, "[redacted]")
    cleaned = _TOKENISH.sub("[redacted]", cleaned)
    cleaned = re.sub(r"[^\S\n]+", " ", cleaned).strip()
    return cleaned or None


def fbtrace_id(value):
    if isinstance(value, str) and _FBTRACE.fullmatch(value):
        return value
    return None


def classify_meta_health(exc):
    """Map a MetaAPIError to BLOCKED, TOKEN, or PERMISSION; otherwise None."""
    if not isinstance(exc, MetaAPIError):
        return None
    message = exc.api_message or ""
    if exc.code == 190:
        return "TOKEN"
    if exc.code == 200 and _BLOCKED.search(message):
        return "BLOCKED"
    if exc.code in (10, 200):
        return "PERMISSION"
    return None


class NoRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Never forward a bearer token to a redirect destination.
        return None


class MetaClient:
    def __init__(self, token_file=TOKEN_PATH, *, read_only=True, timeout=60):
        path = Path(token_file)
        try:
            info = path.stat()
            if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077:
                raise OperationError("Token must be a regular owner-only file (chmod 600).")
            self._token = path.read_text(encoding="ascii").strip()
        except (OSError, UnicodeError):
            raise OperationError("Cannot read the token file.") from None
        if not self._token or any(c.isspace() for c in self._token):
            raise OperationError("Token file is empty or invalid.")
        self.read_only = read_only
        self.timeout = timeout
        self._opener = urllib.request.build_opener(NoRedirects())

    def request(self, method, path, params=None, *, upload=None):
        if method not in ("GET", "POST") or not re.fullmatch(r"[A-Za-z0-9_/-]+", path):
            raise OperationError("Invalid Meta request.")
        if method != "GET" and self.read_only:
            raise OperationError("Read-only mode forbids Meta writes.")
        params = params or {}
        encoded = {k: json.dumps(v, separators=(",", ":")) if isinstance(v, (dict, list))
                   else str(v) for k, v in params.items()}
        url = f"https://graph.facebook.com/{API_VERSION}/{path.lstrip('/')}"
        headers = {"Authorization": "Bearer " + self._token}
        body = None
        if method == "GET":
            url += "?" + urllib.parse.urlencode(encoded)
        elif upload is None:
            body = urllib.parse.urlencode(encoded).encode()
            headers["Content-Type"] = "application/x-www-form-urlencoded"
        else:
            field, file_path, upload_name = upload
            if not re.fullmatch(r"[A-Za-z0-9_.-]+", upload_name):
                raise OperationError("Invalid upload filename.")
            file_path = Path(file_path)
            if file_path.stat().st_size > 100 * 1024 * 1024:
                raise OperationError("This helper limits buffered uploads to 100 MiB.")
            boundary = "SafetyRadar" + os.urandom(16).hex()
            parts = []
            for key, value in encoded.items():
                parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n'.encode())
            parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{field}"; filename="{upload_name}"\r\nContent-Type: application/octet-stream\r\n\r\n'.encode())
            parts.extend([file_path.read_bytes(), f"\r\n--{boundary}--\r\n".encode()])
            body = b"".join(parts)
            headers["Content-Type"] = "multipart/form-data; boundary=" + boundary
        request = urllib.request.Request(url, data=body, headers=headers, method=method)
        try:
            with self._opener.open(request, timeout=self.timeout) as response:
                result = json.load(response)
        except urllib.error.HTTPError as exc:
            # Meta messages and paging URLs can echo credentials. Print numeric codes only.
            try:
                error = json.loads(exc.read()).get("error", {})
            except (ValueError, AttributeError):
                error = {}
            finally:
                exc.close()
            codes = [f"HTTP {exc.code}"]
            for key in ("code", "error_subcode"):
                value = error.get(key)
                if isinstance(value, int):
                    codes.append(f"{key}={value}")
            raise MetaAPIError(
                "Meta request failed (" + ", ".join(codes) + "). No automatic write retry.",
                code=error.get("code") if isinstance(error.get("code"), int) else None,
                status=exc.code,
                api_message=sanitize_meta_text(error.get("message"), token=self._token),
                fbtrace_id=fbtrace_id(error.get("fbtrace_id")),
                error_type=error.get("type") if isinstance(error.get("type"), str) else None,
                subcode=error.get("error_subcode") if isinstance(error.get("error_subcode"), int) else None,
            ) from None
        except (OSError, ValueError):
            raise OperationError("Meta transport/JSON failure. A submitted write may have succeeded; reconcile its journal before retrying.") from None
        if not isinstance(result, dict) or "error" in result:
            raise OperationError("Unexpected Meta response; inspect operation state before retrying.")
        return result

    def get(self, path, params=None):
        return self.request("GET", path, params)

    def post(self, path, params=None, *, upload=None):
        return self.request("POST", path, params, upload=upload)

    def pages(self, path, params=None, *, max_pages=100):
        query = dict(params or {})
        query.setdefault("limit", 100)
        seen = set()
        for _ in range(max_pages):
            result = self.get(path, query)
            data = result.get("data")
            if not isinstance(data, list) or not all(isinstance(row, dict) for row in data):
                raise OperationError("Invalid Meta list response.")
            yield from data
            paging = result.get("paging", {})
            if not paging.get("next"):
                return
            after = paging.get("cursors", {}).get("after")
            if not after or after in seen:
                raise OperationError("Meta pagination did not advance; report/check is incomplete.")
            seen.add(after)
            query["after"] = after
        raise OperationError("Meta pagination limit exceeded; report/check is incomplete.")


def caption_key(text):
    return " ".join(unicodedata.normalize("NFKC", text).split()).casefold()


def digest_file(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def fingerprint(payload):
    return hashlib.sha256(json.dumps(payload, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def read_text(path, *, max_chars=2200, strip=True):
    try:
        text = Path(path).read_text(encoding="utf-8")
        if strip:
            text = text.strip()
    except (OSError, UnicodeError):
        raise OperationError("Cannot read the UTF-8 copy file.") from None
    if not text.strip() or len(text) > max_chars:
        raise OperationError(f"Copy must contain 1 through {max_chars} characters.")
    return text


def probe_video(path, *, reel=False, allow_missing_color_tags=False):
    path = Path(path)
    if not path.is_file() or path.suffix.lower() != ".mp4":
        raise OperationError("An existing MP4 input is required.")
    try:
        result = subprocess.run(["ffprobe", "-v", "error", "-show_streams", "-show_format",
                                 "-of", "json", str(path.resolve())], capture_output=True, check=True, timeout=30)
        info = json.loads(result.stdout)
        video = next(s for s in info["streams"] if s.get("codec_type") == "video")
        duration = float(info["format"]["duration"])
    except (OSError, ValueError, KeyError, StopIteration, subprocess.SubprocessError):
        raise OperationError("ffprobe could not validate the MP4.") from None
    if video.get("codec_name") != "h264" or video.get("pix_fmt") != "yuv420p":
        raise OperationError("MP4 must contain H.264 yuv420p video.")
    if not 3 <= duration <= 900:
        raise OperationError("Video duration must be between 3 and 900 seconds.")
    if reel and ((video.get("width"), video.get("height")) != (1080, 1920)
                 or video.get("color_space") != "bt709"
                 or any(video.get(k) not in (("bt709", None) if allow_missing_color_tags else ("bt709",))
                        for k in ("color_primaries", "color_transfer"))
                 or video.get("color_range") != "tv"):
        raise OperationError("Reel must be 1080x1920, limited-range BT.709 including primaries and transfer. Re-render with current make_reel.py.")
    return {"duration": duration, "width": video["width"], "height": video["height"],
            "codec": video["codec_name"], "color_space": video.get("color_space"),
            "color_primaries": video.get("color_primaries"), "color_transfer": video.get("color_transfer")}


def save_json(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as handle:
        temp = Path(handle.name)
        try:
            os.fchmod(handle.fileno(), 0o600)
            json.dump(data, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        except BaseException:
            temp.unlink(missing_ok=True)
            raise
    os.replace(temp, path)
    fd = os.open(path.parent, os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def append_jsonl(path, record):
    """Append one JSON object to a private journal. Never store tokens or raw URLs."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with path.open("a", encoding="utf-8") as handle:
        os.fchmod(handle.fileno(), 0o600)
        handle.write(json.dumps(record, ensure_ascii=False) + "\n")
        handle.flush()
        os.fsync(handle.fileno())


def save_text(path, text, *, mode=0o644):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as handle:
        temp = Path(handle.name)
        try:
            os.fchmod(handle.fileno(), mode)
            handle.write(text)
            if not text.endswith("\n"):
                handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        except BaseException:
            temp.unlink(missing_ok=True)
            raise
    os.replace(temp, path)


def load_json(path):
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except (OSError, ValueError):
        raise OperationError("Operation journal is unreadable; do not discard it to retry.") from None
    if not isinstance(data, dict):
        raise OperationError("Invalid operation journal.")
    return data


@contextlib.contextmanager
def operation_lock(state_dir, name):
    state_dir = Path(state_dir)
    state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (state_dir / (name + ".lock")).open("a+") as handle:
        os.fchmod(handle.fileno(), 0o600)
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise OperationError("Another operation holds the lock.") from None
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


def print_result(value):
    print(json.dumps(value, ensure_ascii=False, indent=2))


def run_cli(main):
    try:
        main()
    except OperationError as exc:
        print_result({"error": str(exc)})
        raise SystemExit(1) from None
    except KeyboardInterrupt:
        print_result({"error": "Interrupted. Inspect the journal before retrying a write."})
        raise SystemExit(130) from None
    except Exception as exc:
        # No raw exception text or traceback: a library exception may contain a token.
        print_result({"error": "Operation failed; inspect private state before retrying.", "type": type(exc).__name__})
        raise SystemExit(1) from None
