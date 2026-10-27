#!/usr/bin/env python3
"""Integration test for the add-videos service (add/addserver.py).

Starts the real server on a scratch root, with the real prep.py converting
and a fake yt-dlp (no internet needed), then drives the API like the phone
page and an iPhone Shortcut would.

    tools/test_add.py [--keep]
"""

import http.client
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.parse

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PASS, FAIL = [], []

FAKE_YTDLP = r'''#!/usr/bin/env python3
import json, os, re, subprocess, sys, time
args = sys.argv[1:]
root = os.environ["FAKE_ROOT"]
with open(os.path.join(root, "ytdlp-calls.log"), "a") as f:
    f.write(json.dumps(args) + "\n")
url = args[args.index("--") + 1] if "--" in args else args[-1]
if "--flat-playlist" in args:
    print(json.dumps({"title": "Test List", "entries": [
        {"id": "aaaaaaaaaa1", "title": "First One"}, {"id": "aaaaaaaaaa2", "title": "Second One"},
        {"id": "bbbbbbbbbb1", "title": "[Private video]"}]}))
    sys.exit(0)
vid = re.search(r"v=([\w-]{11})", url).group(1)
if vid == "privatevid0":
    sys.stderr.write("ERROR: [youtube] privatevid0: Private video. Sign in if you've been granted access\n")
    sys.exit(1)
if vid == "brokenvid00" and not os.path.exists(os.path.join(root, "state", "fake-updated")):
    sys.stderr.write("ERROR: [youtube] brokenvid00: Unable to extract nsig function code\n")
    sys.exit(1)
out = args[args.index("-o") + 1].replace("%(ext)s", "mp4")
title = {"aaaaaaaaaa1": "First One", "aaaaaaaaaa2": "Second One"}.get(vid, "Mr. Fake: Video " + vid)
print("TSTREAM-INFO " + json.dumps({"id": vid, "title": title, "duration": 3, "filesize_approx": 100000,
                                    "extractor_key": "Youtube"}), flush=True)
for i in range(1, 5):
    print("TSTREAM-PROG downloading %d 400000 NA" % (i * 100000), flush=True)
    time.sleep(1.5 if vid == "slowvid0000" else 0.05)
print("TSTREAM-PROG finished 400000 400000 NA", flush=True)
subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=s=320x240:r=25:d=3", "-f", "lavfi",
                "-i", "sine=d=3", "-c:v", "libx264", "-c:a", "aac", "-shortest", out], check=True)
print("TSTREAM-FILE " + out, flush=True)
'''

FAKE_UPDATER = '''#!/bin/sh
touch "$FAKE_ROOT/state/fake-updated"
echo "yt-dlp is up to date (fake)"
'''


def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(("  ok    " if cond else "  FAIL  ") + name + ("" if cond else "   " + str(detail)))


class Client:
    def __init__(self, port, ip="192.168.1.50"):
        self.port, self.ip, self.cookie, self.key = port, ip, None, None

    def req(self, method, path, body=None, headers=None, raw=False):
        h = {"X-Forwarded-For": self.ip, "Host": "pi.local"}
        if not raw:
            h["X-TStream"] = "1"
        if self.cookie:
            h["Cookie"] = self.cookie
        if self.key:
            h["X-TStream-Key"] = self.key
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode()
            h["Content-Type"] = "application/json"
        h.update(headers or {})
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=30)
        c.request(method, path, body=body, headers=h)
        r = c.getresponse()
        data = r.read()
        sc = r.getheader("Set-Cookie")
        if sc and sc.startswith("tsadd=") and "Max-Age=0" not in sc:
            self.cookie = sc.split(";")[0]
        try:
            j = json.loads(data or b"{}")
        except ValueError:
            j = {"raw": data[:200]}
        c.close()
        return r.status, j, r

    def get(self, path):
        return self.req("GET", path)

    def post(self, path, body=None):
        return self.req("POST", path, body if body is not None else {})


def wait_for(fn, timeout=60, every=0.3):
    end = time.time() + timeout
    while time.time() < end:
        v = fn()
        if v:
            return v
        time.sleep(every)
    return None


def job(c, pred):
    st, j, _ = c.get("/add/api/state")
    for x in j.get("jobs", []):
        if pred(x):
            return x
    return None


def make_video(path, seconds=3):
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=320x240:r=25:d=%d" % seconds,
                    "-f", "lavfi", "-i", "sine=d=%d" % seconds, "-c:v", "libx264", "-c:a", "aac", "-shortest",
                    path], check=True)


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def setup(root):
    """A scratch install root with the fake yt-dlp and updater."""
    for d in ("source", "site/media", "state", "bin", "yt-dlp/bin"):
        os.makedirs(os.path.join(root, d), exist_ok=True)
    cfg = json.load(open(os.path.join(REPO, "config.json")))
    json.dump(cfg, open(os.path.join(root, "config.json"), "w"))
    for name, text in (("yt-dlp/bin/yt-dlp", FAKE_YTDLP), ("bin/yt-dlp-update.sh", FAKE_UPDATER)):
        with open(os.path.join(root, name), "w") as f:
            f.write(text)
        os.chmod(os.path.join(root, name), 0o755)
    with open(os.path.join(root, "state", "add-https-url.txt"), "w") as f:
        f.write("https://pi.tail1234.ts.net/add/\n")
    open(os.path.join(root, "state", "yt-dlp-updated"), "w").close()  # updated just now


def main():
    if sys.argv[1:2] == ["--setup"]:  # only make the root (tools/e2e-add.sh)
        setup(sys.argv[2])
        return
    keep = "--keep" in sys.argv
    root = tempfile.mkdtemp(prefix="tstream-add-")
    print("root:", root)
    setup(root)
    port = free_port()
    env = dict(os.environ, FAKE_ROOT=root)
    log = open(os.path.join(root, "addserver.log"), "w")
    srv = subprocess.Popen([sys.executable, "-u", os.path.join(REPO, "add", "addserver.py"), "--root", root,
                            "--port", str(port), "--prep-dir", os.path.join(REPO, "prep")],
                           stdout=log, stderr=subprocess.STDOUT, env=env)
    try:
        def up():
            try:
                socket.create_connection(("127.0.0.1", port), 1).close()
                return True
            except OSError:
                return False
        if not wait_for(up, 15):
            raise SystemExit("the server did not start")
        run(port, root)
    finally:
        srv.terminate()
        srv.wait(10)
        log.close()
        print("\n%d passed, %d failed" % (len(PASS), len(FAIL)))
        if FAIL:
            print("server log:\n" + open(os.path.join(root, "addserver.log")).read()[-3000:])
        if not keep and not FAIL:
            shutil.rmtree(root, ignore_errors=True)
    sys.exit(1 if FAIL else 0)


def run(port, root):
    pin = open(os.path.join(root, "state", "add-pin.txt")).read().strip()
    print("access")
    st, j, _ = Client(port, ip="8.8.8.8").get("/add/api/state")
    check("internet address refused", st == 403, st)
    st, j, r = Client(port).req("GET", "/add/", raw=True)
    check("page served", st == 200 and b"Add videos" in r.read() + b"" or st == 200, st)
    st, j, _ = Client(port).req("GET", "/add/api/state", raw=True)
    check("API without X-TStream header refused (other web sites)", st == 403, st)
    st, j, _ = Client(port).get("/add/api/state")
    check("API without PIN -> 401", st == 401, st)
    st, j, r = Client(port).req("GET", "/add/share?text=" + urllib.parse.quote("Look https://youtu.be/abcdefghijk?si=x"),
                                raw=True)
    loc = urllib.parse.unquote(r.getheader("Location") or "")
    check("share target -> page with the link", st == 303 and loc.startswith("/add/?link=https://youtu.be/abcdefghijk"),
          (st, loc))

    bad = Client(port, ip="192.168.1.66")
    codes = [bad.post("/add/api/login", {"pin": "000000" if pin != "000000" else "111111"})[0] for _ in range(6)]
    check("wrong PIN -> 403, then 429 after 5 tries", codes[:5] == [403] * 5 and codes[5] == 429, codes)
    st, j, _ = bad.post("/add/api/login", {"pin": pin})
    check("right PIN still refused while locked out", st == 429, st)

    c = Client(port)
    st, j, _ = c.post("/add/api/login", {"pin": pin})
    check("login with PIN sets a cookie", st == 200 and c.cookie, (st, j))
    st, s, _ = c.get("/add/api/state")
    check("state", st == 200 and "jobs" in s and s["space"]["free"] > 0 and s["ytdlp"] is True, (st, s))
    check("state has the https address", s.get("httpsUrl") == "https://pi.tail1234.ts.net/add/", s.get("httpsUrl"))

    print("upload")
    vid = os.path.join(root, "phone clip.mp4")
    make_video(vid, 4)
    data = open(vid, "rb").read()
    size = len(data)
    meta = {"name": "IMG_0001.MP4", "size": size, "lastModified": 1700000000000, "type": "video/mp4",
            "category": "Family", "duration": 4}
    st, j, _ = c.post("/add/api/upload", dict(meta, name="notes.txt", type="text/plain"))
    check("non-video refused", st == 415, (st, j))
    st, up, _ = c.post("/add/api/upload", meta)
    check("upload start", st == 200 and up.get("offset") == 0 and up["id"].startswith("up"), (st, up))
    uid = up["id"]
    half = size // 2
    st, j, _ = c.req("PUT", "/add/api/upload/%s?offset=0" % uid, data[:half])
    check("first piece", st == 200 and j.get("offset") == half, (st, j))
    st, j, _ = c.req("PUT", "/add/api/upload/%s?offset=0" % uid, data[:half])
    check("wrong offset -> 409 with the right one", st == 409 and j.get("offset") == half, (st, j))
    # a piece cut off mid-way must leave no half piece behind
    s2 = socket.create_connection(("127.0.0.1", port))
    hdr = ("PUT /add/api/upload/%s?offset=%d HTTP/1.1\r\nHost: pi.local\r\nX-TStream: 1\r\nX-Forwarded-For: "
           "192.168.1.50\r\nCookie: %s\r\nContent-Length: %d\r\n\r\n" % (uid, half, c.cookie, size - half))
    s2.sendall(hdr.encode() + data[half:half + 1000])
    s2.close()
    time.sleep(0.5)
    part = os.path.join(root, "source", ".incoming", uid + ".part")
    check("cut-off piece truncated back", wait_for(lambda: os.path.getsize(part) == half, 5), os.path.getsize(part))
    st, j, _ = c.post("/add/api/upload", meta)  # picked again after a reload
    check("same file again resumes at the offset", st == 200 and j.get("id") == uid and j.get("offset") == half,
          (st, j))
    body = data[half:]
    chunked = b"%x\r\n%s\r\n0\r\n\r\n" % (len(body), body)
    st, j, _ = c.req("PUT", "/add/api/upload/%s?offset=%d" % (uid, half), chunked,
                     {"Transfer-Encoding": "chunked"})
    check("last piece (chunked encoding) completes it", st == 200 and j.get("done"), (st, j))
    dest = os.path.join(root, "source", "Family", "IMG 0001.mp4")
    check("file placed under its category", os.path.exists(dest) and open(dest, "rb").read() == data,
          os.listdir(os.path.join(root, "source")))
    check("placed file looks settled to prep", time.time() - os.stat(dest).st_mtime > 60)
    check("no partial file left", not os.path.exists(part))
    ready = wait_for(lambda: job(c, lambda x: x["id"] == uid and x["state"] == "ready"), 90)
    check("converted and on the toy", ready, job(c, lambda x: x["id"] == uid))
    cat = json.load(open(os.path.join(root, "site", "media", "catalog.json")))
    titles = [i["title"] for x in cat["categories"] for i in x["items"]]
    check("in the toy's catalog", "IMG 0001" in titles, titles)
    st, j, _ = c.post("/add/api/upload", meta)
    check("same file once more -> already on the toy", st == 200 and j.get("already"), (st, j))

    print("links")
    st, j, _ = c.post("/add/api/link", {"url": "not a link", "category": "Cartoons"})
    check("text without a link refused", st == 400, (st, j))
    st, j, _ = c.post("/add/api/link", {"url": "Watch: https://youtu.be/abcdefghijk?si=xyz", "category": "Cartoons"})
    check("YouTube link queued", st == 200 and j.get("id"), (st, j))
    lid = j.get("id")
    st, j, _ = c.post("/add/api/link", {"url": "https://www.youtube.com/watch?v=abcdefghijk", "category": "Cartoons"})
    check("same video again -> already queued", st == 200 and j.get("already"), (st, j))
    ready = wait_for(lambda: job(c, lambda x: x["id"] == lid and x["state"] == "ready"), 90)
    check("downloaded, converted, on the toy", ready, job(c, lambda x: x["id"] == lid))
    check("title from YouTube keeps its dot; no characters USB drives refuse",
          ready and ready["title"] == "Mr. Fake - Video abcdefghijk", ready and ready["title"])
    st, j, _ = c.post("/add/api/link", {"url": "https://m.youtube.com/shorts/abcdefghijk", "category": "Cartoons"})
    check("same video (as a Short link) -> already on the toy", st == 200 and j.get("already")
          and "on the toy" in j.get("message", ""), (st, j))
    calls = [json.loads(l) for l in open(os.path.join(root, "ytdlp-calls.log"))]
    a = calls[-1]
    check("yt-dlp asked for 480p (short side), H.264 first, no playlist, with progress",
          "--no-playlist" in a and a[a.index("-S") + 1] == "res:480,vcodec:h264,acodec:aac"
          and "--progress" in a and "--ignore-config" in a, a)

    st, j, _ = c.post("/add/api/link", {"url": "https://www.youtube.com/watch?v=privatevid0", "category": "Cartoons"})
    pj = wait_for(lambda: job(c, lambda x: x["id"] == j["id"] and x["state"] == "failed"), 30)
    check("private video -> plain explanation", pj and pj["error"] == "This video is private.", pj)

    st, j, _ = c.post("/add/api/link", {"url": "https://youtu.be/brokenvid00", "category": "Cartoons"})
    bj = wait_for(lambda: job(c, lambda x: x["id"] == j["id"] and x["state"] in ("ready", "failed")), 90)
    check("yt-dlp out of date -> updated and tried again", bj and bj["state"] == "ready"
          and os.path.exists(os.path.join(root, "state", "fake-updated")), bj)

    st, j, _ = c.post("/add/api/link", {"url": "https://youtu.be/slowvid0000", "category": "Cartoons"})
    wait_for(lambda: job(c, lambda x: x["id"] == j["id"] and x["state"] == "downloading"), 30)
    st2, k, _ = c.post("/add/api/job/%s/cancel" % j["id"])
    cj = wait_for(lambda: job(c, lambda x: x["id"] == j["id"] and x["state"] == "cancelled"), 10)
    time.sleep(1)
    left = [f for f in os.listdir(os.path.join(root, "source", ".incoming")) if "slowvid" in f or j["id"] in f]
    check("cancel a download", st2 == 200 and cj and not left, (cj, left))

    print("playlists")
    st, j, _ = c.post("/add/api/link", {"url": "https://www.youtube.com/playlist?list=PLtest123",
                                        "category": "Songs", "watch": True})
    check("playlist accepted", st == 200 and j.get("id"), (st, j))
    pl = wait_for(lambda: job(c, lambda x: x["id"] == j["id"] and x["state"] == "listed"), 30)
    check("playlist read: 2 videos (private one skipped)", pl and pl["added"] == 2 and pl["title"] == "Test List", pl)
    both = wait_for(lambda: len([x for x in c.get("/add/api/state")[1]["jobs"]
                                 if x["category"] == "Songs" and x["state"] == "ready"]) == 2, 120)
    check("playlist videos on the toy", both)
    st, s, _ = c.get("/add/api/state")
    check("playlist is watched", [p["id"] for p in s["playlists"]] == ["PLtest123"], s["playlists"])

    print("remove")
    st, lib, _ = c.get("/add/api/library")
    first = next((i for i in lib.get("items", []) if i["title"] == "First One"), None)
    check("library lists the videos", first and first["thumb"].startswith("../media/"), lib)
    st, j, _ = c.post("/add/api/remove", {"id": first["id"]})
    check("remove", st == 200 and j.get("original"), (st, j))
    cat = json.load(open(os.path.join(root, "site", "media", "catalog.json")))
    titles = [i["title"] for x in cat["categories"] for i in x["items"]]
    check("removed from the toy's catalog at once", "First One" not in titles, titles)
    check("original deleted", not os.path.exists(os.path.join(root, "source", "Songs", "First One.mp4")))
    st, j, _ = c.post("/add/api/link", {"url": "https://www.youtube.com/playlist?list=PLtest123", "category": "Songs"})
    pl2 = wait_for(lambda: job(c, lambda x: x["id"] == j.get("id") and x["state"] == "listed"), 30)
    check("playlist does not bring a removed video back", pl2 and pl2["added"] == 0, pl2)
    st, j, _ = c.post("/add/api/link", {"url": "https://youtu.be/aaaaaaaaaa1", "category": "Songs"})
    check("but adding it on purpose works", st == 200 and not j.get("already"), (st, j))

    print("iPhone Shortcut key")
    st, k, _ = c.post("/add/api/key", {"name": "iPhone"})
    check("key made", st == 200 and len(k.get("key", "")) > 30, (st, k))
    sc = Client(port, ip="100.101.102.103")
    sc.key = k["key"]
    st, j, _ = sc.req("POST", "/add/api/link", {"url": "https://youtu.be/sccutvid000"}, raw=True)
    check("Shortcut adds a link with only its key (last category)", st == 200 and j.get("id")
          and "Songs" in j.get("message", ""), (st, j))
    sc.key = "wrong"
    st, j, _ = sc.req("POST", "/add/api/link", {"url": "https://youtu.be/sccutvid001"}, raw=True)
    check("bad key -> readable message for the notification", st == 200 and "no longer works" in j.get("message", ""),
          (st, j))

    print("PIN reset")
    with open(os.path.join(root, "state", "add-sessions.json"), "w") as f:
        f.write("{}")
    st, j, _ = c.get("/add/api/state")
    check("emptied sessions (tstream new-pin) log the phone out", st == 401, st)
    st, j, _ = c.post("/add/api/logout")
    check("logout without session -> 401", st == 401, st)


if __name__ == "__main__":
    main()
