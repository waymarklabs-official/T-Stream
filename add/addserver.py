#!/usr/bin/env python3
"""T-Stream "Add videos": the page a parent opens on their phone to add
videos to the toy's library, from a YouTube (or other) link or from the
phone itself.

Runs as the library owner on 127.0.0.1:8098. Caddy forwards /add/ to it from
the home-network, hotspot and Tailscale addresses only; the toy's public
Funnel link never reaches it. Everything needs the PIN from `tstream`.

What it does with a video:
  1. downloads it (yt-dlp) or receives it in resumable pieces into
     source/.incoming/ (prep ignores dot folders, so it never sees half a file)
  2. moves the finished file into source/<Category>/<Title>.<ext>
  3. starts prep, which converts it (newest first) and adds it to the toy

    addserver.py [--root /srv/canvas-player] [--port 8098]
"""

import argparse
import datetime
import errno
import fcntl
import hashlib
import ipaddress
import json
import os
import re
import secrets
import shutil
import signal
import subprocess
import sys
import threading
import time
import unicodedata
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_ROOT = "/srv/canvas-player"

CHUNK_MAX = 16 * 1024 * 1024       # largest upload piece accepted
JSON_MAX = 64 * 1024
HOTSPOT_UPLOAD_BYTES_PER_S = 3 * 1024 * 1024  # leave the hotspot's radio for the toy
SESSION_DAYS = 365
LOGIN_TRIES = 5                    # wrong PINs per address ...
LOGIN_WINDOW = 300                 # ... per 5 minutes
LOGIN_TRIES_ALL = 50               # wrong PINs from everyone per hour
YTDLP_UPDATE_HOURS = 24            # YouTube changes often; yt-dlp keeps up
PLAYLIST_CHECK_MINUTES = 60
PLAYLIST_MAX = 300                 # videos added from one playlist at once
KEEP_FINISHED_DAYS = 14
ABANDONED_UPLOAD_DAYS = 3

PRIVATE_NETS = [ipaddress.ip_network(n) for n in (
    "127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "169.254.0.0/16",
    "::1/128", "fc00::/7", "fe80::/10")]

STATIC = {
    "": ("index.html", "text/html; charset=utf-8"),
    "index.html": ("index.html", "text/html; charset=utf-8"),
    "add.js": ("add.js", "application/javascript; charset=utf-8"),
    "add.css": ("add.css", "text/css; charset=utf-8"),
    "manifest.webmanifest": ("manifest.webmanifest", "application/manifest+json"),
    "icon-192.png": ("icon-192.png", "image/png"),
    "icon-512.png": ("icon-512.png", "image/png"),
}

YT_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")


def log(msg):
    print("%s %s" % (datetime.datetime.now().strftime("%m-%d %H:%M:%S"), msg), flush=True)


def now_iso():
    return datetime.datetime.now().isoformat(timespec="seconds")


def read_json(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def write_json(path, data, mode=0o644):
    tmp = "%s.%d.tmp" % (path, os.getpid())
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
    with os.fdopen(fd, "w") as f:
        json.dump(data, f, indent=1)
    os.replace(tmp, path)


def fsync_dir(path):
    try:
        fd = os.open(path, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    except OSError:
        pass


def clean_name(s, limit=120):
    """A title or category usable as a file/folder name (and readable), also
    on FAT/exFAT USB drives and network shares."""
    s = unicodedata.normalize("NFC", str(s or ""))
    s = re.sub(r"[\x00-\x1f\x7f/\\]+", " ", s)
    s = re.sub(r"\s*[:|]+\s*", " - ", s)  # "Show: Episode | Channel" -> "Show - Episode - Channel"
    s = re.sub(r'[*?"<>]+', "", s.replace('"', "'"))
    s = s.rstrip(". ")  # Windows-style file systems drop trailing dots
    s = re.sub(r"\s+", " ", s).strip().lstrip(".").strip()
    while len(s.encode("utf-8")) > limit:
        s = s[:-1]
    return s.strip()


# ------------------------------------------------------------------ links ---

def find_url(text):
    """The first http(s) link in shared text ("Watch this! https://youtu.be/...")."""
    m = re.search(r"https?://[^\s<>\"']+", str(text or ""))
    return m.group(0).rstrip(".,;:!?)]}") if m else None


def youtube_ids(url):
    """(video_id, playlist_id) for YouTube links, else (None, None)."""
    try:
        u = urllib.parse.urlsplit(url)
    except ValueError:
        return None, None
    host = (u.hostname or "").lower()
    q = urllib.parse.parse_qs(u.query)
    vid = None
    if host in ("youtu.be", "www.youtu.be"):
        vid = u.path.strip("/").split("/")[0]
    elif host == "youtube.com" or host.endswith(".youtube.com") or host == "youtube-nocookie.com" \
            or host.endswith(".youtube-nocookie.com"):
        parts = [p for p in u.path.split("/") if p]
        if parts[:1] == ["watch"]:
            vid = (q.get("v") or [None])[0]
        elif len(parts) >= 2 and parts[0] in ("shorts", "live", "embed", "v", "e"):
            vid = parts[1]
        elif parts[:1] != ["playlist"]:
            return None, None
    else:
        return None, None
    vid = vid if vid and YT_ID.match(vid) else None
    lst = (q.get("list") or [None])[0]
    lst = lst if lst and re.match(r"^[A-Za-z0-9_-]{2,64}$", lst) else None
    if vid is None and lst is None:
        return None, None
    return vid, lst


def friendly_error(text):
    """yt-dlp's last ERROR line, said plainly when we know what it means."""
    lines = [l for l in str(text).splitlines() if l.strip()]
    err = next((l for l in reversed(lines) if l.startswith("ERROR:")), lines[-1] if lines else "unknown error")
    err = re.sub(r"^ERROR:\s*(\[[^\]]+\]\s*[\w-]+:\s*)?", "", err).strip()
    low = err.lower()
    for words, plain in (
            (("private video",), "This video is private."),
            (("members-only", "join this channel"), "This video is for channel members only."),
            (("sign in to confirm your age", "age-restricted", "inappropriate for some users"),
             "YouTube wants a signed-in adult for this video (age-restricted)."),
            (("sign in to confirm you", "not a bot"),
             "YouTube is asking the Pi to prove it is not a robot. Try again later."),
            (("video unavailable", "has been removed", "no longer available", "account associated"),
             "This video is not available (removed or blocked)."),
            (("not available in your country", "blocked it in your country"), "This video is blocked in this country."),
            (("live event will begin", "premieres in", "is_live", "is live"), "Live streams and premieres can't be added; try after it ends."),
            (("unable to download webpage", "temporary failure in name resolution", "network is unreachable",
              "connection refused", "timed out", "getaddrinfo failed"), "The Pi can't reach the internet right now."),
            (("no space left on device",), "The Pi's memory card is full."),
            (("unsupported url",), "This link doesn't lead to a video the Pi can download.")):
        if any(w in low for w in words):
            return plain
    return err[:300]


def ytdlp_broken(text):
    """Errors that usually mean yt-dlp is out of date for YouTube's latest change."""
    low = str(text).lower()
    return any(w in low for w in ("unable to extract", "signature", "nsig", "please report this issue",
                                  "requested format is not available", "http error 403", "challenge",
                                  "only images are available", "po token"))


# ------------------------------------------------------------------- app ----

class Http(Exception):
    def __init__(self, code, message, **extra):
        super().__init__(message)
        self.code = code
        self.extra = extra


class App:
    def __init__(self, root, prep_dir, add_dir):
        self.root = root
        self.add_dir = add_dir
        self.source = os.path.join(root, "source")
        self.media = os.path.join(root, "site", "media")
        self.state = os.path.join(root, "state")
        self.incoming = os.path.join(self.source, ".incoming")
        for d in (self.source, self.media, self.state, self.incoming):
            os.makedirs(d, exist_ok=True)
        sys.path.insert(0, prep_dir)
        import prep  # noqa: E402  (the installed converter: names, titles, catalog)
        self.prep = prep
        self.prep_py = os.path.join(prep_dir, "prep.py")
        self.cfg_path = os.path.join(root, "config.json")
        self.lock = threading.RLock()
        self.wake_prep = threading.Event()
        self.wake_dl = threading.Event()
        self.prep_proc = None
        self.dl_proc = None
        self.dl_job = None
        self.fail_ip = {}
        self.fail_all = []
        self.sizes = (0, None)

        self.jobs_path = os.path.join(self.state, "add-jobs.json")
        self.sess_path = os.path.join(self.state, "add-sessions.json")
        self.pin_path = os.path.join(self.state, "add-pin.txt")
        self.lists_path = os.path.join(self.state, "add-playlists.json")
        self.ledger_path = os.path.join(self.state, "add-ledger.json")
        self.prefs_path = os.path.join(self.state, "add-prefs.json")
        self.jobs = read_json(self.jobs_path, {})
        self.playlists = read_json(self.lists_path, {})
        self.ledger = read_json(self.ledger_path, {})   # "youtube:<id>" -> {"rel", "at"}
        self.prefs = read_json(self.prefs_path, {})
        self.sessions = {}
        self.sess_mtime = None
        self.pin()  # make one now, so `tstream` can show it
        for j in self.jobs.values():  # a restart interrupted these
            if j["state"] == "downloading":
                j["state"], j["pct"] = "queued", 0
        self.cleanup_incoming()
        self.save_jobs()

    # ------------------------------------------------------------ files ---
    def save_jobs(self):
        with self.lock:
            write_json(self.jobs_path, self.jobs)

    def save(self, path, data, mode=0o644):
        with self.lock:
            write_json(path, data, mode)

    def config(self):
        return self.prep.load_config(self.cfg_path if os.path.exists(self.cfg_path) else None)

    # ------------------------------------------------------------- auth ---
    def pin(self):
        try:
            with open(self.pin_path) as f:
                p = f.read().strip()
            if re.match(r"^\d{4,12}$", p):
                return p
        except OSError:
            pass
        p = "%06d" % secrets.randbelow(10 ** 6)
        fd = os.open(self.pin_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(p + "\n")
        return p

    def load_sessions(self):
        try:
            m = os.stat(self.sess_path).st_mtime
        except OSError:
            m = None
        if m != self.sess_mtime:  # `tstream new-pin` empties the file
            self.sess_mtime = m
            self.sessions = read_json(self.sess_path, {}) if m else {}
        return self.sessions

    def save_sessions(self):
        write_json(self.sess_path, self.sessions, 0o600)
        self.sess_mtime = os.stat(self.sess_path).st_mtime

    def new_session(self, kind, name=""):
        token = secrets.token_urlsafe(32)
        with self.lock:
            s = self.load_sessions()
            s[hashlib.sha256(token.encode()).hexdigest()] = {"kind": kind, "name": name[:60], "made": int(time.time())}
            browsers = sorted((k for k in s if s[k]["kind"] == "browser"), key=lambda k: s[k]["made"])
            for k in browsers[:-50]:
                del s[k]
            self.save_sessions()
        return token

    def valid(self, token):
        if not token:
            return False
        with self.lock:
            s = self.load_sessions().get(hashlib.sha256(token.encode()).hexdigest())
        return bool(s and (s["kind"] == "key" or time.time() - s["made"] < SESSION_DAYS * 86400))

    def drop_session(self, token):
        with self.lock:
            if self.load_sessions().pop(hashlib.sha256(token.encode()).hexdigest(), None):
                self.save_sessions()

    def login(self, ip, pin):
        t = time.time()
        with self.lock:
            tries = self.fail_ip[ip] = [x for x in self.fail_ip.get(ip, []) if t - x < LOGIN_WINDOW]
            self.fail_all = [x for x in self.fail_all if t - x < 3600]
            if len(tries) >= LOGIN_TRIES:
                raise Http(429, "Too many wrong PINs. Wait %d minutes, then try again."
                           % max(1, round((LOGIN_WINDOW - (t - tries[0])) / 60)))
            if len(self.fail_all) >= LOGIN_TRIES_ALL:
                raise Http(429, "Too many wrong PINs on this network. Try again in an hour, or make a new PIN on "
                           "the Pi: tstream new-pin")
            if not secrets.compare_digest(str(pin).strip(), self.pin()):
                tries.append(t)
                self.fail_all.append(t)
                raise Http(403, "Wrong PIN. It is shown on the Pi by the command: tstream")
            self.fail_ip.pop(ip, None)
        return self.new_session("browser")

    # ------------------------------------------------------------ space ---
    def space(self):
        du = shutil.disk_usage(self.media)
        t, cached = self.sizes
        if cached is None or time.time() - t > 60:
            def tree(path):
                total = 0
                for dirpath, _, files in os.walk(path):
                    for fn in files:
                        try:
                            total += os.lstat(os.path.join(dirpath, fn)).st_size
                        except OSError:
                            pass
                return total
            hours = 0.0
            cat = read_json(os.path.join(self.media, "catalog.json"), {})
            for c in cat.get("categories", []):
                for i in c.get("items", []):
                    hours += (i.get("duration") or 0) / 3600
            cached = {"library": tree(self.media), "originals": tree(self.source), "hours": round(hours, 1)}
            self.sizes = (time.time(), cached)
        lib = cached["library"]
        per_hour = lib / cached["hours"] if cached["hours"] >= 0.5 else 1.2e9
        reserve = self.prep.SPACE_RESERVE
        return dict(cached, free=du.free, total=du.total,
                    hoursLeft=round(max(0, du.free - reserve) / max(per_hour, 0.3e9), 1))

    def need_space(self, size, duration):
        """Raises if size more bytes (plus converting a video of this length)
        would not fit next to everything already arriving."""
        with self.lock:
            arriving = sum(max(0, (j.get("size") or 0) - (j.get("offset") or 0))
                           for j in self.jobs.values() if j["state"] == "uploading")
        need = size + arriving + self.prep.space_needed(self.config(), duration, size)
        free = shutil.disk_usage(self.media).free
        if free < need:
            raise Http(507, "Not enough space on the Pi: this needs about %s, %s is free. Remove some videos "
                       "from the toy first (\"On the toy\" below)." % (self.prep.gb(need), self.prep.gb(free)))

    # ------------------------------------------------------------- jobs ---
    def new_job(self, kind, **kw):
        jid = kw.pop("id", None) or secrets.token_hex(6)
        j = {"id": jid, "kind": kind, "state": "queued", "created": int(time.time()), "pct": 0,
             "error": None, "title": None, "category": None}
        j.update(kw)
        with self.lock:
            self.jobs[jid] = j
            self.prune_jobs()
            self.save_jobs()
        return j

    def prune_jobs(self):
        t = time.time()
        final = ("placed", "failed", "cancelled", "listed")
        for jid in [k for k, j in self.jobs.items()
                    if j["state"] in final and t - j.get("updated", j["created"]) > KEEP_FINISHED_DAYS * 86400]:
            del self.jobs[jid]
        if len(self.jobs) > 300:
            for jid in sorted(self.jobs, key=lambda k: self.jobs[k]["created"])[:len(self.jobs) - 300]:
                if self.jobs[jid]["state"] in final:
                    del self.jobs[jid]

    def update(self, j, save=True, **kw):
        with self.lock:
            j.update(kw)
            j["updated"] = int(time.time())
            if save:
                self.save_jobs()

    def cleanup_incoming(self):
        keep = set()
        t = time.time()
        for j in self.jobs.values():
            if j["state"] == "uploading":
                if t - j.get("updated", j["created"]) > ABANDONED_UPLOAD_DAYS * 86400:
                    j.update(state="failed", error="Upload was not finished.")
                else:
                    keep.add(j["id"] + ".part")
        for fn in os.listdir(self.incoming):
            if fn not in keep and not fn.startswith("."):
                p = os.path.join(self.incoming, fn)
                shutil.rmtree(p, ignore_errors=True) if os.path.isdir(p) else os.remove(p)

    def categories(self):
        names = set()
        for d in os.listdir(self.source):
            if not d.startswith(".") and os.path.isdir(os.path.join(self.source, d)):
                names.add(d)
        for c in read_json(os.path.join(self.media, "catalog.json"), {}).get("categories", []):
            names.add(c["name"])
        return sorted(names, key=self.prep.natural_key)

    def pick_category(self, name):
        c = clean_name(name, 60) or self.prefs.get("category") or "Videos"
        if c != self.prefs.get("category"):
            self.prefs["category"] = c
            self.save(self.prefs_path, self.prefs)
        return c

    def place(self, tmp, category, title, ext, j):
        """Moves a finished file into source/<Category>/<Title>.<ext> (never
        over an existing file) and starts prep."""
        folder = os.path.join(self.source, category)
        os.makedirs(folder, exist_ok=True)
        base = clean_name(title) or "Video"
        n = 1
        while True:
            name = base + (" (%d)" % n if n > 1 else "") + ext
            dest = os.path.join(folder, name)
            try:
                os.link(tmp, dest)  # never replaces an existing file
                break
            except FileExistsError:
                n += 1
            except OSError:  # no hard links on this drive: claim the name, then move
                try:
                    os.close(os.open(dest, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644))
                except FileExistsError:
                    n += 1
                    continue
                shutil.copymode(tmp, dest)
                os.replace(tmp, dest)
                break
        # newest first in prep's queue, and past its "still copying?" wait
        t = time.time() - 61
        os.utime(dest, (t, t))
        fsync_dir(folder)
        if os.path.exists(tmp):
            os.remove(tmp)
        st = os.stat(dest)
        rel = os.path.relpath(dest, self.source)
        self.update(j, state="placed", pct=100, rel=rel, itemId=self.prep.item_id(rel),
                    mtime=int(st.st_mtime), srcSize=st.st_size, title=os.path.splitext(name)[0], category=category)
        log("added %s" % rel)
        self.sizes = (0, None)
        self.wake_prep.set()
        return rel

    def prep_status(self):
        return read_json(os.path.join(self.state, "prep-status.json"), {})

    def view(self, j, st):
        """A job as the page shows it, with conversion progress from prep."""
        v = {k: j.get(k) for k in ("id", "kind", "state", "title", "category", "pct", "error", "url",
                                   "size", "offset", "created", "name", "lastModified", "added", "watch")}
        if j["state"] != "placed":
            return v
        rel = j["rel"].replace(os.sep, "/")
        m = read_json(os.path.join(self.media, j["itemId"], "manifest.json"), None)
        if m and m.get("source", {}).get("mtime") == j["mtime"] and m["source"].get("size") == j["srcSize"]:
            removed = os.path.exists(os.path.join(self.media, j["itemId"], self.prep.REMOVED))
            v.update(state="removed" if removed else "ready", id_on_toy=j["itemId"])
            return v
        if not os.path.exists(os.path.join(self.source, j["rel"])):
            v["state"] = "removed"
            return v
        cur = st.get("current") or {}
        f = (st.get("failed") or {}).get(rel)
        if st.get("running") and cur.get("path") == rel:
            v.update(state="converting", pct=cur.get("pct", 0))
        elif f and f.get("mtime") == j["mtime"] and f.get("size") == j["srcSize"]:
            v.update(state="failed", error="Could not convert: " + str(f.get("error", ""))[-300:])
        else:
            v.update(state="waiting", pct=0)
        return v

    def state_view(self):
        st = self.prep_status()
        with self.lock:
            jobs = sorted(self.jobs.values(), key=lambda j: -j["created"])[:60]
            views = [self.view(j, st) for j in jobs]
            lists = [dict(p, id=k) for k, p in self.playlists.items()]
        try:  # written by remote-on / install.sh: https://<pi>.<tailnet>.ts.net/add/
            with open(os.path.join(self.state, "add-https-url.txt")) as f:
                https_url = f.read().strip() or None
        except OSError:
            https_url = None
        return {"jobs": views, "categories": self.categories(), "category": self.prefs.get("category"),
                "space": self.space(), "playlists": lists, "ytdlp": bool(self.ytdlp_cmd()),
                "converting": bool(st.get("running")), "httpsUrl": https_url}

    # ------------------------------------------------------------- prep ---
    def prep_running(self):
        try:
            with open(os.path.join(self.media, ".prep.lock"), "a") as f:
                fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
                fcntl.flock(f, fcntl.LOCK_UN)
            return False
        except OSError:
            return True

    def waiting_jobs(self):
        st = self.prep_status()
        with self.lock:
            return [j for j in self.jobs.values() if j["state"] == "placed" and self.view(j, st)["state"] == "waiting"]

    def prep_loop(self):
        """Starts prep whenever a placed video waits and no prep is running
        (prep looks for new files after each video, so a running one picks
        new arrivals up by itself)."""
        last = 0
        while True:
            kicked = self.wake_prep.wait(20)
            self.wake_prep.clear()
            if self.prep_proc and self.prep_proc.poll() is not None:
                self.prep_proc = None
            if self.prep_proc or (not kicked and time.time() - last < 60):
                continue
            if not self.waiting_jobs() or self.prep_running():
                continue
            last = time.time()
            logf = open(os.path.join(self.root, "prep.log"), "a")
            cmd = [sys.executable, "-u", self.prep_py, "--root", self.root, "--no-wait"]
            if shutil.which("nice"):
                cmd = ["nice", "-n", "10"] + cmd
            log("starting prep")
            self.prep_proc = subprocess.Popen(cmd, stdout=logf, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL)
            logf.close()

    # ---------------------------------------------------------- removal ---
    def library(self):
        out = []
        cat = read_json(os.path.join(self.media, "catalog.json"), {})
        for c in cat.get("categories", []):
            for i in c.get("items", []):
                out.append({"id": i["id"], "title": i["title"], "category": c["name"],
                            "duration": i.get("duration"), "thumb": "../" + i["thumb"]})
        return out

    def remove(self, iid):
        if not re.match(r"^[0-9a-f]{10}$", str(iid)):
            raise Http(400, "bad id")
        item = os.path.join(self.media, iid)
        m = read_json(os.path.join(item, "manifest.json"), None)
        if not m:
            raise Http(404, "That video is not on the toy any more.")
        rel = (m.get("source") or {}).get("path") or ""
        src = os.path.realpath(os.path.join(self.source, rel))
        gone = False
        if rel and src.startswith(os.path.realpath(self.source) + os.sep) and os.path.isfile(src):
            os.remove(src)
            gone = True
        # the files stay a few minutes (the toy may be playing it); prep deletes them
        with open(os.path.join(item, self.prep.REMOVED), "w") as f:
            f.write(now_iso() + "\n")
        self.prep.build_catalog(self.media, self.config())
        with self.lock:  # a watched playlist must not bring it back
            for v in self.ledger.values():
                if v.get("rel") == rel:
                    v["removed"] = True
            self.save(self.ledger_path, self.ledger)
        self.sizes = (0, None)
        log("removed %s (%s)" % (iid, rel))
        return {"ok": True, "original": gone}

    # ----------------------------------------------------------- upload ---
    def upload_start(self, d):
        name = clean_name(os.path.basename(str(d.get("name", ""))), 200)
        ext = os.path.splitext(name)[1].lower()
        if ext not in self.prep.VIDEO_EXTS and str(d.get("type", "")).startswith("video/"):
            # some pickers hand over names without an extension; ffmpeg reads the content anyway
            ext = {"video/quicktime": ".mov", "video/webm": ".webm", "video/x-matroska": ".mkv",
                   "video/3gpp": ".3gp", "video/x-msvideo": ".avi"}.get(d["type"], ".mp4")
            name += ext
        if ext not in self.prep.VIDEO_EXTS:
            raise Http(415, "\"%s\" is not a video file the Pi knows (%s)." % (name or "?", ", ".join(
                sorted(e[1:] for e in self.prep.VIDEO_EXTS))))
        try:
            size, lm = int(d.get("size")), int(d.get("lastModified") or 0)
        except (TypeError, ValueError):
            raise Http(400, "bad size")
        if size <= 0:
            raise Http(400, "This file is empty.")
        category = self.pick_category(d.get("category"))
        title = clean_name(d.get("title")) or self.prep.clean_title(os.path.splitext(name)[0])
        # the same file picked again (after a reload) continues where it stopped
        jid = "up" + hashlib.sha1(("%s|%s|%d|%d" % (category, name, size, lm)).encode()).hexdigest()[:10]
        with self.lock:
            j = self.jobs.get(jid)
            if j and j["state"] == "uploading":
                part = os.path.join(self.incoming, jid + ".part")
                off = os.path.getsize(part) if os.path.exists(part) else 0
                self.update(j, offset=off, title=title)
                return {"id": jid, "offset": off}
            if j and j["state"] == "placed" and self.view(j, self.prep_status())["state"] in ("ready", "waiting",
                                                                                                "converting"):
                return {"id": jid, "offset": size, "already": True}
        try:
            duration = float(d.get("duration")) if d.get("duration") else None
        except (TypeError, ValueError):
            duration = None
        self.need_space(size, duration)
        open(os.path.join(self.incoming, jid + ".part"), "wb").close()
        self.new_job("upload", id=jid, state="uploading", name=name, size=size, offset=0, lastModified=lm,
                     category=category, title=title, ext=ext)
        return {"id": jid, "offset": 0}

    def upload_piece(self, jid, offset, body_reader, length, throttle):
        with self.lock:
            j = self.jobs.get(jid)
            if not j or j["state"] != "uploading":
                raise Http(404, "This upload is no longer waiting. Pick the file again.")
        part = os.path.join(self.incoming, jid + ".part")
        with _part_lock(jid):
            have = os.path.getsize(part) if os.path.exists(part) else 0
            if offset != have:
                raise Http(409, "offset mismatch", offset=have)
            if have + length > j["size"]:
                raise Http(400, "more data than the file has")
            t0 = time.time()
            got = 0
            try:
                with open(part, "r+b") as f:
                    f.seek(have)
                    for block in body_reader:
                        f.write(block)
                        got += len(block)
                        if throttle:
                            ahead = got / HOTSPOT_UPLOAD_BYTES_PER_S - (time.time() - t0)
                            if ahead > 0:
                                time.sleep(ahead)
                    f.flush()
                    os.fsync(f.fileno())
                if got != length:
                    raise ConnectionError("short piece")
            except BaseException as e:
                with open(part, "r+b") as f:  # never keep half a piece
                    f.truncate(have)
                if isinstance(e, OSError) and e.errno == errno.ENOSPC:
                    raise Http(507, "The Pi's memory card is full.")
                raise
            off = have + got
            if off < j["size"]:
                self.update(j, save=time.time() - j.get("updated", 0) > 5, offset=off,
                            pct=int(off * 100 / j["size"]))
                return {"offset": off}
            self.update(j, offset=off, pct=100)
            self.place(part, j["category"], j["title"], j["ext"], j)
            return {"offset": off, "done": True}

    # ---------------------------------------------------------- youtube ---
    def ytdlp_cmd(self):
        for p in (os.path.join(self.root, "yt-dlp", "bin", "yt-dlp"),):
            if os.access(p, os.X_OK):
                return [p]
        p = shutil.which("yt-dlp")
        return [p] if p else None

    def ytdlp_env(self):
        env = dict(os.environ, PYTHONIOENCODING="utf-8")
        extra = [os.path.join(self.root, "deno", "bin"), os.path.join(self.root, "yt-dlp", "bin")]
        env["PATH"] = os.pathsep.join(extra + [env.get("PATH", "/usr/bin:/bin")])
        return env

    def ytdlp_update(self, force=False):
        stamp = os.path.join(self.state, "yt-dlp-updated")
        try:
            if not force and time.time() - os.stat(stamp).st_mtime < YTDLP_UPDATE_HOURS * 3600:
                return
        except OSError:
            pass
        updater = os.path.join(self.root, "bin", "yt-dlp-update.sh")
        if not os.access(updater, os.X_OK):
            return
        log("updating yt-dlp")
        try:
            p = subprocess.run([updater], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=600,
                               env=self.ytdlp_env(), encoding="utf-8", errors="replace")
            log("yt-dlp update: %s" % (p.stdout.strip().splitlines() or ["done"])[-1])
        except (OSError, subprocess.TimeoutExpired) as e:
            log("yt-dlp update failed: %s" % e)
        with open(stamp, "w"):
            pass

    def add_link(self, d):
        url = find_url(d.get("url") or d.get("text"))
        if not url:
            raise Http(400, "That doesn't look like a link. In YouTube tap Share, then Copy link, and paste it here.")
        if not self.ytdlp_cmd():
            raise Http(503, "The YouTube downloader is not installed on the Pi yet. Run on the Pi: tstream update")
        category = self.pick_category(d.get("category"))
        title = clean_name(d.get("title"))
        vid, lst = youtube_ids(url)
        if lst and (not vid or d.get("playlist")):
            j = self.new_job("playlist", url="https://www.youtube.com/playlist?list=" + lst, list=lst,
                             category=category, watch=bool(d.get("watch")))
            self.wake_dl.set()
            return {"id": j["id"], "message": "Reading the playlist..."}
        if vid:
            url = "https://www.youtube.com/watch?v=" + vid
            dup = self.duplicate("youtube:" + vid)
            if dup:
                return {"message": dup, "already": True}
        self.need_space(0, 600)  # a 10-minute video; checked again once its length is known
        j = self.new_job("link", url=url, key="youtube:" + vid if vid else None, category=category,
                         title=title or None, wantTitle=bool(title))
        self.wake_dl.set()
        return {"id": j["id"], "message": "Added to the queue (%s)." % category}

    def duplicate(self, key, but=None):
        """A message if this video is already queued or on the toy."""
        with self.lock:
            for j in self.jobs.values():
                if j.get("key") == key and j["state"] in ("queued", "downloading") and j["id"] != but:
                    return "Already in the queue: %s" % (j.get("title") or j.get("url"))
            e = self.ledger.get(key)
        if e and not e.get("removed") and os.path.exists(os.path.join(self.source, e["rel"])):
            return "Already on the toy: %s" % os.path.splitext(os.path.basename(e["rel"]))[0]
        return None

    def run_ytdlp(self, args, timeout=None):
        cmd = self.ytdlp_cmd() + args
        return subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout,
                              env=self.ytdlp_env(), encoding="utf-8", errors="replace")

    def read_playlist(self, j):
        self.update(j, state="downloading", pct=0, error=None)
        try:
            added, title = self.check_playlist(j["url"], j["category"])
        except Http as e:
            return self.update(j, state="failed", error=str(e))
        if j.get("watch"):
            with self.lock:
                self.playlists[j["list"]] = {"url": j["url"], "title": title, "category": j["category"],
                                             "checked": int(time.time()), "error": None}
                self.save(self.lists_path, self.playlists)
        self.update(j, state="listed", title=title, added=added)

    def check_playlist(self, url, category):
        self.ytdlp_update()
        p = self.run_ytdlp(["--ignore-config", "--flat-playlist", "-J", "--no-warnings",
                            "--cache-dir", os.path.join(self.state, "yt-dlp-cache"), url], timeout=300)
        if p.returncode != 0:
            raise Http(502, friendly_error(p.stderr))
        try:
            info = json.loads(p.stdout)
        except ValueError:
            raise Http(502, "The playlist could not be read.")
        title = clean_name(info.get("title")) or "Playlist"
        added = 0
        for e in (info.get("entries") or [])[:PLAYLIST_MAX]:
            vid = e.get("id")
            if not vid or not YT_ID.match(vid) or e.get("availability") in ("private", "needs_auth") \
                    or (e.get("title") or "").strip("[] ").lower() in ("private video", "deleted video"):
                continue
            key = "youtube:" + vid
            with self.lock:
                if self.ledger.get(key, {}).get("removed"):  # removed from the toy on purpose
                    continue
            if self.duplicate(key):
                continue
            self.new_job("link", url="https://www.youtube.com/watch?v=" + vid, key=key, category=category,
                         title=clean_name(e.get("title")) or None, wantTitle=False, playlist=title)
            added += 1
        self.wake_dl.set()
        return added, title

    def playlist_loop(self):
        time.sleep(120)
        while True:
            for lst, p in list(self.playlists.items()):
                if time.time() - p.get("checked", 0) < PLAYLIST_CHECK_MINUTES * 60:
                    continue
                try:
                    n, title = self.check_playlist(p["url"], p["category"])
                    p.update(checked=int(time.time()), title=title, error=None)
                    if n:
                        log("playlist %s: %d new" % (title, n))
                except Exception as e:
                    p.update(checked=int(time.time()), error=str(e)[:200])
                with self.lock:
                    if lst in self.playlists:
                        self.save(self.lists_path, self.playlists)
            time.sleep(300)

    def stop_playlist(self, lst):
        with self.lock:
            if self.playlists.pop(lst, None) is None:
                raise Http(404, "not watched")
            self.save(self.lists_path, self.playlists)
        return {"ok": True}

    def download_loop(self):
        while True:
            self.wake_dl.wait(30)
            self.wake_dl.clear()
            while True:
                with self.lock:
                    queued = sorted((j for j in self.jobs.values()
                                     if j["state"] == "queued" and j["kind"] in ("link", "playlist")),
                                    key=lambda j: (j["kind"] != "playlist", j["created"]))
                if not queued:
                    break
                j = queued[0]
                if len(queued) > 1:
                    time.sleep(3)  # YouTube limits how many videos a guest gets per hour
                try:
                    self.read_playlist(j) if j["kind"] == "playlist" else self.download(j)
                except Exception as e:  # never let one video stop the queue
                    log("download %s failed: %s" % (j["id"], e))
                    if j["state"] == "downloading":
                        self.update(j, state="failed", error=str(e)[:300])
                finally:
                    for fn in os.listdir(self.incoming):
                        if fn.startswith("yt-%s." % j["id"]):
                            try:
                                os.remove(os.path.join(self.incoming, fn))
                            except OSError:
                                pass

    def download(self, j):
        self.update(j, state="downloading", pct=0, error=None)
        self.ytdlp_update()
        for attempt in (1, 2):
            ok, err = self.download_once(j)
            if ok or j["state"] != "downloading":
                return
            if attempt == 1 and ytdlp_broken(err):
                log("download failed, updating yt-dlp and trying again: %s" % err.strip()[-200:])
                self.ytdlp_update(force=True)
                continue
            break
        self.update(j, state="failed", error=friendly_error(err))

    def download_once(self, j):
        out = os.path.join(self.incoming, "yt-%s.%%(ext)s" % j["id"])
        args = [
            "--ignore-config", "--no-playlist", "--no-simulate", "--no-mtime", "--no-colors",
            "--cache-dir", os.path.join(self.state, "yt-dlp-cache"),
            "--match-filters", "!is_live & live_status!=is_upcoming",
            "--retries", "10", "--fragment-retries", "10", "--socket-timeout", "30",
            ] + self.format_args() + [
            "--print", "before_dl:TSTREAM-INFO %(.{id,title,duration,filesize_approx,extractor_key})j",
            "--print", "after_move:TSTREAM-FILE %(filepath)s",
            # --print turns progress off; these bring it back, one line per update
            "--progress", "--newline", "--progress-delta", "1",
            "--progress-template", "download:TSTREAM-PROG %(progress.status)s %(progress.downloaded_bytes)s "
                                   "%(progress.total_bytes)s %(progress.total_bytes_estimate)s",
            "-o", out, "--", j["url"]]
        cmd = self.ytdlp_cmd() + args
        errf = open(os.path.join(self.incoming, "yt-%s.log" % j["id"]), "w+")
        p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=errf, stdin=subprocess.DEVNULL,
                             env=self.ytdlp_env(), encoding="utf-8", errors="replace")
        self.dl_proc, self.dl_job = p, j["id"]
        path, info, done, total = None, {}, 0, 0
        last_save = 0
        try:
            for line in p.stdout:
                if line.startswith("TSTREAM-INFO "):
                    try:
                        info = json.loads(line[13:])
                    except ValueError:
                        info = {}
                    key = "%s:%s" % (str(info.get("extractor_key", "")).lower(), info.get("id"))
                    dup = self.duplicate(key, but=j["id"]) if info.get("id") else None
                    if dup:
                        self.update(j, state="failed", error=dup)
                        p.kill()
                        break
                    total = info.get("filesize_approx") or 0
                    self.update(j, key=key, duration=info.get("duration"),
                                title=j["title"] if j.get("wantTitle") else clean_name(info.get("title")) or j["title"])
                    try:
                        self.need_space(total or 0, info.get("duration") or 1800)
                    except Http as e:
                        self.update(j, state="failed", error=str(e))
                        p.kill()
                        break
                elif line.startswith("TSTREAM-PROG "):
                    f = line.split()
                    try:
                        status, got = f[1], int(float(f[2]))
                        size = int(float(f[3])) if f[3] not in ("NA", "None") else \
                            int(float(f[4])) if f[4] not in ("NA", "None") else 0
                    except (ValueError, IndexError):
                        continue
                    if status == "finished":
                        done += size or got
                        got = 0
                    whole = max(total, done + max(size, got), 1)
                    pct = min(99, int((done + got) * 100 / whole))
                    if pct != j["pct"]:
                        self.update(j, save=time.time() - last_save > 5, pct=pct)
                        last_save = time.time()
                elif line.startswith("TSTREAM-FILE "):
                    path = line[13:].strip()
                if j["state"] == "cancelled":
                    p.kill()
            p.wait()
        finally:
            self.dl_proc = self.dl_job = None
            errf.seek(0)
            err = errf.read()
            errf.close()
        if j["state"] != "downloading":
            return False, err
        if p.returncode != 0 or not path or not os.path.isfile(path):
            if p.returncode == 0 and "does not pass filter" in err:
                return False, "ERROR: is live"
            return False, err or "yt-dlp stopped (exit %s)" % p.returncode
        ext = os.path.splitext(path)[1].lower()
        if ext not in self.prep.VIDEO_EXTS:
            return False, "ERROR: the download is not a video file (%s)" % ext
        rel = self.place(path, j["category"], j["title"] or "Video", ext, j)
        with self.lock:
            if j.get("key"):
                self.ledger[j["key"]] = {"rel": rel, "at": now_iso()}
                self.save(self.ledger_path, self.ledger)
        return True, ""

    def format_args(self):
        # The size the toy gets (480 on the short side, so Shorts too) and
        # H.264 + AAC when YouTube has them: the Pi decodes H.264 fastest,
        # while AV1/VP9 (YouTube's favourites) are slow for it.
        h = int(self.config()["height"])
        return ["-f", "bv*+ba/b", "-S", "res:%d,vcodec:h264,acodec:aac" % h, "--merge-output-format", "mp4/mkv"]

    def cancel(self, jid):
        with self.lock:
            j = self.jobs.get(jid)
            if not j:
                raise Http(404, "not found")
            if j["state"] in ("queued", "downloading", "uploading"):
                self.update(j, state="cancelled")
                if self.dl_job == jid and self.dl_proc:
                    try:
                        self.dl_proc.send_signal(signal.SIGTERM)
                    except OSError:
                        pass
                part = os.path.join(self.incoming, jid + ".part")
                if os.path.exists(part):
                    os.remove(part)
            else:
                del self.jobs[jid]
                self.save_jobs()
        return {"ok": True}

    def retry(self, jid):
        with self.lock:
            j = self.jobs.get(jid)
            if not j or j["state"] not in ("failed", "cancelled") or j["kind"] not in ("link", "playlist"):
                raise Http(400, "This can't be tried again; add it again instead.")
            self.update(j, state="queued", pct=0, error=None)
        self.wake_dl.set()
        return {"ok": True}


_part_locks = {}
_part_locks_guard = threading.Lock()


def _part_lock(jid):
    with _part_locks_guard:
        return _part_locks.setdefault(jid, threading.Lock())


# --------------------------------------------------------------- server ----

class Handler(BaseHTTPRequestHandler):
    server_version = "tstream-add"
    timeout = 120  # a phone that stops sending mid-piece frees its thread
    app = None  # set in main()

    def log_message(self, fmt, *args):  # Caddy keeps the access log
        pass

    def client_ip(self):
        fwd = self.headers.get("X-Forwarded-For")
        ip = (fwd.split(",")[-1] if fwd else self.client_address[0]).strip()
        try:
            return ipaddress.ip_address(ip.split("%")[0])
        except ValueError:
            return None

    def token(self):
        key = self.headers.get("X-TStream-Key")
        if key:
            return key.strip()
        for part in (self.headers.get("Cookie") or "").split(";"):
            k, _, v = part.strip().partition("=")
            if k == "tsadd":
                return v
        return None

    def send(self, code, body, ctype="application/json; charset=utf-8", headers=()):
        if not isinstance(body, bytes):
            body = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        for k, v in headers:
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def body_reader(self, limit):
        """Yields the request body in blocks (Content-Length or chunked)."""
        if "chunked" in (self.headers.get("Transfer-Encoding") or "").lower():
            def chunks():
                total = 0
                while True:
                    line = self.rfile.readline(1024)
                    if not line:
                        return
                    n = int(line.split(b";")[0].strip() or b"0", 16)
                    if n == 0:
                        while self.rfile.readline(1024).strip():
                            pass
                        return
                    total += n
                    if total > limit:
                        raise Http(413, "piece too large")
                    left = n
                    while left:
                        b = self.rfile.read(min(left, 1 << 20))
                        if not b:
                            return
                        left -= len(b)
                        yield b
                    self.rfile.readline(1024)
            return chunks(), None
        n = int(self.headers.get("Content-Length") or 0)
        if n > limit:
            raise Http(413, "piece too large")

        def plain():
            left = n
            while left:
                b = self.rfile.read(min(left, 1 << 20))
                if not b:
                    return
                left -= len(b)
                yield b
        return plain(), n

    def json_body(self):
        reader, _ = self.body_reader(JSON_MAX)
        raw = b"".join(reader)
        try:
            d = json.loads(raw or b"{}")
        except ValueError:
            raise Http(400, "bad request")
        if not isinstance(d, dict):
            raise Http(400, "bad request")
        return d

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        self.route("GET")

    def do_POST(self):
        self.route("POST")

    def do_PUT(self):
        self.route("PUT")

    def route(self, method):
        app = self.app
        try:
            ip = self.client_ip()
            if ip is None or not any(ip in n for n in PRIVATE_NETS):
                raise Http(403, "Only from your home network, the hotspot or Tailscale.")
            u = urllib.parse.urlsplit(self.path)
            path = u.path
            if not path.startswith("/add/"):
                if path == "/add":
                    return self.send(301, b"", "text/plain", [("Location", "/add/")])
                raise Http(404, "not found")
            sub = path[5:]
            if method == "GET" and sub in STATIC:
                fn, ctype = STATIC[sub]
                try:
                    with open(os.path.join(app.add_dir, fn), "rb") as f:
                        return self.send(200, f.read(), ctype)
                except OSError:
                    raise Http(404, "not found")
            if method == "GET" and sub == "share":
                # Android's share sheet (installed page): open the page with the link filled in
                q = urllib.parse.parse_qs(u.query)
                link = find_url(" ".join(q.get("url", []) + q.get("text", []) + q.get("title", []))) or ""
                return self.send(303, b"", "text/plain", [("Location", "/add/?link=" + urllib.parse.quote(link))])
            if not sub.startswith("api/"):
                raise Http(404, "not found")
            if self.headers.get("X-TStream") != "1" and not self.headers.get("X-TStream-Key"):
                raise Http(403, "missing header")  # other web sites can't send it
            api = sub[4:]
            secure = self.headers.get("X-Forwarded-Proto") == "https"
            if method == "POST" and api == "login":
                token = app.login(str(ip), self.json_body().get("pin", ""))
                cookie = "tsadd=%s; Path=/add/; Max-Age=%d; HttpOnly; SameSite=Lax%s" % (
                    token, SESSION_DAYS * 86400, "; Secure" if secure else "")
                return self.send(200, {"ok": True}, headers=[("Set-Cookie", cookie)])
            token = self.token()
            if not app.valid(token):
                raise Http(401, "PIN needed")
            if method == "GET" and api == "state":
                return self.send(200, app.state_view())
            if method == "GET" and api == "library":
                return self.send(200, {"items": app.library()})
            if method == "POST" and api == "logout":
                app.drop_session(token)
                return self.send(200, {"ok": True}, headers=[("Set-Cookie", "tsadd=; Path=/add/; Max-Age=0")])
            if method == "POST" and api == "link":
                return self.send(200, app.add_link(self.json_body()))
            if method == "POST" and api == "upload":
                return self.send(200, app.upload_start(self.json_body()))
            m = re.match(r"^upload/(up[0-9a-f]{10})$", api)
            if method == "PUT" and m:
                q = urllib.parse.parse_qs(u.query)
                try:
                    offset = int((q.get("offset") or ["-1"])[0])
                except ValueError:
                    raise Http(400, "bad offset")
                reader, n = self.body_reader(CHUNK_MAX)
                if n is None:  # chunked: read it all first (bounded by CHUNK_MAX)
                    data = b"".join(reader)
                    reader, n = iter([data]), len(data)
                throttle = (self.headers.get("X-Forwarded-Host") or self.headers.get("Host") or "").split(":")[0] \
                    == "10.42.0.1"
                return self.send(200, app.upload_piece(m.group(1), offset, reader, n, throttle))
            m = re.match(r"^job/([0-9a-z]{8,14})/(cancel|retry)$", api)
            if method == "POST" and m:
                return self.send(200, app.cancel(m.group(1)) if m.group(2) == "cancel" else app.retry(m.group(1)))
            if method == "POST" and api == "remove":
                return self.send(200, app.remove(self.json_body().get("id")))
            m = re.match(r"^playlist/([A-Za-z0-9_-]{2,64})/stop$", api)
            if method == "POST" and m:
                return self.send(200, app.stop_playlist(m.group(1)))
            if method == "POST" and api == "key":
                name = clean_name(self.json_body().get("name"), 60) or "Shortcut"
                return self.send(200, {"key": app.new_session("key", name)})
            raise Http(404, "not found")
        except Http as e:
            body = dict({"error": str(e), "message": str(e), "ok": False}, **e.extra)
            if self.headers.get("X-TStream-Key"):
                # iPhone Shortcuts: always a readable answer for its notification
                if e.code == 401:
                    body["message"] = "This Shortcut's key no longer works. Make a new one on the Add videos page."
                return self.send(200, body)
            return self.send(e.code, body)
        except (ConnectionError, TimeoutError):
            return None
        except Exception as e:
            log("error in %s %s: %r" % (method, self.path, e))
            return self.send(500, {"error": "Something went wrong on the Pi: %s" % e})


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--root", default=os.environ.get("CANVAS_ROOT", DEFAULT_ROOT))
    ap.add_argument("--port", type=int, default=8098)
    ap.add_argument("--bind", default="127.0.0.1")
    ap.add_argument("--prep-dir", help="folder with prep.py (default ROOT/bin, else the repo's prep/)")
    args = ap.parse_args(argv)
    prep_dir = args.prep_dir or os.path.join(args.root, "bin")
    if not os.path.exists(os.path.join(prep_dir, "prep.py")):
        prep_dir = os.path.join(os.path.dirname(HERE), "prep")
    app = App(args.root, prep_dir, HERE)
    Handler.app = app
    for target in (app.prep_loop, app.download_loop, app.playlist_loop):
        threading.Thread(target=target, daemon=True).start()
    server = ThreadingHTTPServer((args.bind, args.port), Handler)
    server.daemon_threads = True
    log("add-videos page on http://%s:%d/add/ (root %s)" % (args.bind, args.port, args.root))
    app.wake_prep.set()
    app.wake_dl.set()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
