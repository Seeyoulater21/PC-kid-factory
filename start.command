#!/bin/bash
# Kid Factory launcher: double-click in Finder. Closing this Terminal window stops the app.
cd "$(dirname "$0")" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

pause() { echo; read -r -p "กด Enter เพื่อปิด" _; }

if ! command -v node >/dev/null 2>&1; then
  echo "ไม่พบ Node.js — กรุณาติดตั้งก่อน (https://nodejs.org หรือ brew install node) แล้วดับเบิลคลิกใหม่"
  pause; exit 1
fi
if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ไม่พบ ffmpeg — กรุณาติดตั้งก่อน (brew install ffmpeg) แล้วดับเบิลคลิกใหม่"
  pause; exit 1
fi

if [ ! -d node_modules ]; then
  echo "กำลังติดตั้งส่วนประกอบครั้งแรก…"
  if ! npm ci; then
    echo "ติดตั้งไม่สำเร็จ ตรวจสอบอินเทอร์เน็ตแล้วลองใหม่"
    pause; exit 1
  fi
fi

BASE=4848
LAST=4858
is_ours() { curl -s -m 2 "http://127.0.0.1:$1/api/state" 2>/dev/null | grep -q '"savedIdeas"'; }

open_window() {
  local url="$1"
  [ "$KIDFACTORY_NO_WINDOW" = "1" ] && return 0
  local profile="$HOME/Library/Application Support/KidFactory-chrome"
  mkdir -p "$profile"
  if [ -d "/Applications/Google Chrome.app" ]; then
    open -na "Google Chrome" --args --app="$url" --user-data-dir="$profile"
  elif [ -d "/Applications/Microsoft Edge.app" ]; then
    open -na "Microsoft Edge" --args --app="$url" --user-data-dir="$profile"
  else
    open "$url"
  fi
}

# Already running? Just open the window.
for p in $(seq $BASE $LAST); do
  if is_ours "$p"; then
    echo "โปรแกรมเปิดอยู่แล้ว กำลังเปิดหน้าต่าง…"
    open_window "http://127.0.0.1:$p/"
    echo "READY http://127.0.0.1:$p/ (reused)"
    exit 0
  fi
done

PORT=""
for p in $(seq $BASE $LAST); do
  if ! nc -z 127.0.0.1 "$p" >/dev/null 2>&1; then PORT=$p; break; fi
done
if [ -z "$PORT" ]; then
  echo "ไม่มีพอร์ตว่าง ($BASE-$LAST) ปิดโปรแกรมอื่นแล้วลองใหม่"
  pause; exit 1
fi

echo "กำลังเปิดโปรแกรม…"
node src/server.mjs --port "$PORT" &
SERVER_PID=$!
cleanup() { kill "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null; }
trap 'cleanup; exit 0' INT TERM HUP
trap cleanup EXIT

ok=""
for _ in $(seq 1 40); do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then break; fi
  if is_ours "$PORT"; then ok=1; break; fi
  sleep 0.5
done
if [ -z "$ok" ]; then
  echo "เปิดโปรแกรมไม่สำเร็จ (รอเกิน 20 วินาที) ดูข้อความด้านบน"
  pause; exit 1
fi

open_window "http://127.0.0.1:$PORT/"
echo "READY http://127.0.0.1:$PORT/"
echo "เปิดแล้ว ปิดหน้าต่างนี้เพื่อปิดโปรแกรม"
wait "$SERVER_PID"
# Only reached when the server stopped by itself (Ctrl-C / closing the window go through the trap above).
echo
read -r -p "โปรแกรมหยุดทำงาน กด Enter เพื่อปิด" _
