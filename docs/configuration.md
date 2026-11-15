# Конфигурация

## Переменные окружения

`.env.example` является шаблоном конфигурации. `.env` содержит секреты и не
добавляется в Git.

| Переменная | Обязательна | Назначение |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | Да | Токен Telegram-бота от BotFather. |
| `TELEGRAM_OWNER_ID` | Да | Числовой Telegram ID владельца. |
| `XUI_BASE_URL` | Да | HTTPS URL панели 3x-ui вместе с secret path. |
| `XUI_USERNAME` | Да | Логин панели 3x-ui. |
| `XUI_PASSWORD` | Да | Пароль панели 3x-ui. |
| `XUI_INBOUND_ID` | Да | ID управляемого RU VLESS inbound. |
| `GE_OUTBOUND_TAG` | Да | `tag` существующего Germany outbound. |
| `DATABASE_PATH` | Нет | SQLite path. Compose задаёт `/app/data/bot.sqlite`. |
| `NORDVPN_PRIVATE_KEY` | Нет | Base64 private key NordLynx. |
| `GE_IPV6_SLOTS_PATH` | Нет | Файл слотов IPv6 GE. По умолчанию `ge-ipv6-slots.json` рядом с базой. |

Пример для Docker:

```env
TELEGRAM_BOT_TOKEN=123456:telegram-token
TELEGRAM_OWNER_ID=123456789
XUI_BASE_URL=https://panel.example.com/secret-panel-path
XUI_USERNAME=admin
XUI_PASSWORD=strong-password
XUI_INBOUND_ID=1
GE_OUTBOUND_TAG=main
DATABASE_PATH=./data/bot.sqlite
NORDVPN_PRIVATE_KEY=
```

`XUI_BASE_URL` должен быть доступен из Docker bridge-сети и использовать
сертификат доверенного CA. Самоподписанный сертификат Bun по умолчанию
отклонит.

## Базовая схема 3x-ui

До запуска бота на RU-сервере уже должны существовать:

1. Один VLESS inbound для клиентских подписок.
2. Один рабочий outbound `RU -> GE`.
3. Стабильный `tag` Germany outbound, например `main`.
4. Routing rule обычных device-профилей через Germany outbound.

Бот не изменяет Germany-сервер и не требует установки компонентов на нём.

Для NordVPN-региона итоговый путь:

```text
client -> RU inbound -> Germany VLESS outbound -> NordLynx -> internet
```

## Подписки и subId

Бот группирует устройства по `subId`. Например, существующие профили:

```text
ilya-pc
ilya-phone
ilya-laptop
```

с общим `subId=Ilya` получают ровно один Prague-профиль:

```text
🇨🇿-ilya-cz-prague
```

Старые device-профили бот не изменяет.

`subId` должен быть непустым ASCII-значением, нормализуемым в уникальный
lowercase slug. При коллизии `/sync` завершится ошибкой без изменения панели.

3x-ui `3.11` строит имя конфига по `Remark Template` (Settings → Subscription),
по умолчанию `{{INBOUND}}-{{EMAIL}}|📊{{TRAFFIC_LEFT}}|⏳{{DAYS_LEFT}}D`.
`{{EMAIL}}` выводится только в первом конфиге каждого `subId`, остальные
получают имя inbound (например, `vless`). Чтобы каждый профиль страны
сохранял своё имя, включите там же `Show identity on every link`
(`subShowIdentityOnAllLinks`).

С 3x-ui `3.2.5` `/panel/api/clients/add` запрещает общий `subId` у разных
клиентов, а с `3.9` `/inbounds/update` игнорирует `settings.clients`. Поэтому бот
создаёт профиль через временный выключенный inbound `countries-staging-<uuid>`
на `127.0.0.1`, привязывает клиента к управляемому inbound через
`/clients/<email>/attach` и удаляет временный inbound. Переименование и
удаление идут через `/clients/update` и `/clients/del`.

## NordVPN private key

`NORDVPN_PRIVATE_KEY` является приватным WireGuard/NordLynx-ключом в base64.
После декодирования он должен занимать ровно 32 байта.

Это не cookie браузера и не поле `token`, скопированное из DevTools сайта
NordVPN.

Ключ:

- передаётся боту только через `.env`;
- не сохраняется в SQLite;
- не выводится в Telegram;
- маскируется в template backups.

Без ключа ручные VLESS exits продолжают работать, а NordVPN-меню показывает
ошибку настройки.

## NordVPN chaining

Бот генерирует NordVPN WireGuard outbound с параметрами:

```json
{
  "protocol": "wireguard",
  "settings": {
    "address": ["10.5.0.2/32"],
    "mtu": 1280,
    "noKernelTun": true
  },
  "streamSettings": {
    "sockopt": { "dialerProxy": "<GE_OUTBOUND_TAG>" }
  }
}
```

Причины:

- `sockopt.dialerProxy` сохраняет UDP-пакеты NordLynx при передаче через
  Germany VLESS outbound; устаревший `proxySettings` Xray `v26.9.8+` не
  принимает;
- `noKernelTun: true` изолирует регионы с одинаковым внутренним адресом
  `10.5.0.2/32`;
- MTU `1280` уменьшает риск fragmentation и зависаний во вложенной цепочке.

Без chaining через GE короткий IP-check может проходить, но страницы и
загрузки начинают зависать в `pending`.

## Ручные VLESS exits

Команда:

```text
/set usa <vless://...>
```

Поддерживаются transports:

- `tcp`;
- `ws`;
- `xhttp`;
- `grpc`.

Поддерживаются security modes:

- `none`;
- `tls`;
- `reality`.

URI разбирается и проверяется до изменения Xray-template. Неизвестные transport
или security modes отклоняются.

## Slug и флаги

Slug принимает lowercase-буквы, цифры и одиночные дефисы:

```text
usa
de
nl-free
us-chicago
```

Флаг определяется по началу slug:

```text
usa     -> 🇺🇸
de      -> 🇩🇪
nl-free -> 🇳🇱
```

Если страну нельзя определить, профиль не создаётся.

## IPv6 GE для URnetwork

ur.io видит адрес, с которого GE подключается к прокси-хосту. Чтобы разные
аккаунты URnetwork не приходили с одного IP, у GE есть пул из 32 случайных
IPv6 из `/48` (каждый в своей `/64`):

```text
клиент -> RU (outbound proxies-<профиль>--ur-*) -> ge-ipv6-slot-NN (копия GE outbound,
  клиент GE ipv6-slot-NN) -> GE (правило user ipv6-slot-NN -> freedom sendThrough <IPv6>)
  -> ur.io по IPv6 -> провайдер URnetwork -> сайт по IPv4 провайдера
```

- Профиль получает случайный свободный слот при первом прокси URnetwork и
  сохраняет его навсегда (`ipv6_slot_bindings`), так что при пересоздании
  прокси адрес не меняется. Адрес виден в карточке профиля.
- Свои SOCKS5/HTTP(S) прокси и страны слоты не используют.
- `/sync` перепривязывает все прокси URnetwork к слотам и обновляет копии GE
  outbound после смены GE-ключей.
- Без файла слотов прокси URnetwork идут через обычный `GE_OUTBOUND_TAG`.

Настройка GE (один раз, идемпотентно):

```bash
GE_XUI_BASE_URL=https://ge-panel.example.com:8080/secret-panel-path GE_XUI_INBOUND_ID=4 \
GE_IPV6_PREFIX=2001:db8:1234::/48 bun scripts/setup-ge-ipv6-slots.ts
# файл data/ge-ipv6-slots.json -> data/ бота; затем на GE:
install -m 755 deploy/ge-ipv6-slots.sh /usr/local/sbin/ge-ipv6-slots
install -m 644 deploy/ge-ipv6-slots.service /etc/systemd/system/
# в unit укажите SLOTS_FILE (путь к data/ge-ipv6-slots.json бота) и DEV (uplink)
systemctl daemon-reload && systemctl enable --now ge-ipv6-slots
```

Скрипт создаёт клиентов `ipv6-slot-NN` в GE inbound и outbounds/rules
`ipv6-slot-NN` в GE-template. Unit вешает адреса на uplink-интерфейс с
`preferred_lft 0`: ядро не берёт их как source по умолчанию, Xray привязывает их
явно. Файл слотов — источник истины: не пересоздавайте его при существующих
GE-клиентах, иначе UUID разойдутся.
