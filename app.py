import os, time, json, logging, urllib.request, threading
from http.server import HTTPServer, BaseHTTPRequestHandler

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN") or os.getenv("BOT_TOKEN") or ""
PORT = int(os.getenv("PORT", "3000"))
GROUP_NAME = "ИВТ-21"

def make_keyboard():
    return {
        "keyboard": [
            [{"text": "📅 Сегодня"}, {"text": "📅 Завтра"}, {"text": "📝 Домашка"}],
            [{"text": "🧹 Дежурные"}, {"text": "⚠️ Долги"}, {"text": "💰 Фонд"}],
            [{"text": "🔥 Роаст"}, {"text": "🧠 Отмазка"}, {"text": "🏛️ Расписание РУК"}]
        ],
        "resize_keyboard": True
    }

def send_msg(chat_id, text):
    if not BOT_TOKEN: return
    url = f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage"
    payload = {"chat_id": chat_id, "text": text, "parse_mode": "Markdown", "reply_markup": make_keyboard()}
    req = urllib.request.Request(url, data=json.dumps(payload).encode("utf-8"), headers={"Content-Type": "application/json"})
    try: urllib.request.urlopen(req, timeout=10)
    except Exception as e: logging.error(e)

def handle_cmd(text, name="Студент"):
    c = text.strip().lower()
    if c in ["/start", "старт", "меню"]:
        return f"👋 *Привет, {name}! Я бот-Староста группы {GROUP_NAME}* 🎓\nУниверситет: РУК (schedule.ruc.su)\n\nВыберите команду в меню:"
    if c in ["/today", "сегодня", "📅 сегодня"]:
        return "📅 *Расписание на сегодня:*\n1 пара (09:00): Сети и телекоммуникации (ауд. 210-ГК)\n2 пара (10:50): Лабораторная Cisco Packet Tracer\n3 пара (13:00): Веб-разработка & API"
    if c in ["/tomorrow", "завтра", "📅 завтра"]:
        return "📅 *Расписание на завтра:*\n2 пара (10:50): Теория вероятностей (ауд. 308-ГК)\n3 пара (13:00): Практика по теорверу"
    if c in ["/dz", "домашка", "📝 домашка"]:
        return "📝 *Домашка:*\n1. Базы данных: Лаба №3 (дедлайн 10.11)\n2. Сети: OSPF в Packet Tracer (дедлайн 08.11)"
    if c in ["/duty", "дежурные", "🧹 дежурные"]:
        return "🧹 *Дежурные сегодня:* Дмитрий Дунаев и Максим Ковалёв\nОбязанности: помыть доску, принести маркеры, проветрить аудиторию."
    if c in ["/debt", "долги", "⚠️ долги"]:
        return "🚨 *Долги:*\n1. Артем Зайцев — Лаба №2 АиСД\n2. Максим Ковалёв — РГР Базы данных"
    if c in ["/roast", "роаст", "🔥 роаст"]:
        return "⚡ Слышь, ты время видел? Деканат уже точит карандаш на твое отчисление! Бегом на пару!"
    if c in ["/excuse", "отмазка", "🧠 отмазка"]:
        return "🤒 «Внезапно обострилась аллергия на ранние подъемы, восстанавливаю чакры дома»."
    if c in ["/ruc", "рук", "🏛️ расписание рук"]:
        return "🏛️ Официальный сайт расписания РУК: https://schedule.ruc.su/"
    return "Напишите /start для вызова меню!"

def poll_telegram():
    if not BOT_TOKEN:
        logging.warning("Укажите переменную TELEGRAM_BOT_TOKEN в панели Amvera!")
        return
    offset = 0
    while True:
        try:
            url = f"https://api.telegram.org/bot{BOT_TOKEN}/getUpdates?offset={offset}&timeout=20"
            with urllib.request.urlopen(url, timeout=30) as r:
                data = json.loads(r.read().decode("utf-8"))
                if data.get("ok"):
                    for u in data.get("result", []):
                        offset = u["update_id"] + 1
                        m = u.get("message")
                        if m and "text" in m:
                            send_msg(m["chat"]["id"], handle_cmd(m["text"], m.get("from", {}).get("first_name", "Студент")))
        except Exception:
            time.sleep(3)

class Health(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'{"status":"ok"}')
    def log_message(self, *a): pass

if __name__ == "__main__":
    threading.Thread(target=lambda: HTTPServer(("0.0.0.0", PORT), Health).serve_forever(), daemon=True).start()
    poll_telegram()
