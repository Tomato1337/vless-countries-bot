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

Чтобы экспортированный remark начинался с emoji, задайте в настройках подписок
3x-ui `Remark Model` равным:

```text
-ei
```

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
  "proxySettings": {
    "tag": "<GE_OUTBOUND_TAG>",
    "transportLayer": true
  }
}
```

Причины:

- `transportLayer: true` сохраняет UDP-пакеты NordLynx при передаче через
  Germany VLESS outbound;
- `noKernelTun: true` изолирует регионы с одинаковым внутренним адресом
  `10.5.0.2/32`;
- MTU `1280` уменьшает риск fragmentation и зависаний во вложенной цепочке.

Если убрать `transportLayer`, короткий IP-check может проходить, но страницы и
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
