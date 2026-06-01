# Эксплуатация

## Права доступа

Владелец задаётся через `TELEGRAM_OWNER_ID`.

Владелец может:

- добавлять и удалять exits;
- выполнять `/sync`;
- управлять trusted users;
- использовать NordVPN Repair.

Trusted users могут управлять exits, но не могут изменять allowlist.

Бот принимает управляющие команды только в личном чате.

## Команды

```text
/start
/countries
/nord
/set usa <vless://...>
/remove usa
/sync
/allow <telegram-id>
/deny <telegram-id>
/trusted
```

| Команда | Назначение |
| --- | --- |
| `/start` | Открыть кнопочное меню. |
| `/countries` | Показать созданные exits. |
| `/nord` | Добавить NordVPN-регион через кнопки. |
| `/set` | Добавить или обновить ручной VLESS exit. |
| `/remove` | Удалить exit после подтверждения. |
| `/sync` | Добавить недостающие профили для новых `subId`. |
| `/allow` | Разрешить доступ Telegram ID. Только владелец. |
| `/deny` | Отозвать доступ Telegram ID. Только владелец. |
| `/trusted` | Показать allowlist. Только владелец. |

## Добавление NordVPN-региона

1. Откройте `/nord`.
2. Выберите страну.
3. Выберите город.
4. Запустите автоматический подбор или выберите hostname вручную.
5. Бот протестирует candidate outbound.
6. После успешного теста бот обновит Xray-template и создаст профили подписок.

Можно добавить несколько регионов одной страны:

```text
🇺🇸-ilya-us-chicago
🇺🇸-ilya-us-new-york
```

Уже занятый регион помечается в кнопочном интерфейсе.

## Repair

Кнопка `Repair` доступна только для NordVPN-регионов.

Repair:

1. Повторно получает список NordVPN hostname нужного города.
2. Сначала тестирует наименее загруженные альтернативы.
3. Сохраняет первый рабочий outbound.
4. Не меняет UUID пользовательских профилей.
5. Перезапускает Xray через штатный endpoint 3x-ui.

Для ручного VLESS exit используйте повторный `/set`.

## Разделение ownership

Бот изменяет только:

- outbounds с префиксом `countries-`;
- routing rules с префиксом `countries-`;
- UUID клиентов, записанные самим ботом в SQLite.

Бот не изменяет:

- старые device-профили;
- Germany outbound;
- одиночный `nord-...` outbound, созданный вручную в UI панели;
- неизвестные routing rules и outbounds.

NordVPN exit нельзя перезаписать ручным `/set`, и наоборот.

## Safe apply

При добавлении или замене exit:

1. Бот получает актуальный Xray-template.
2. Проверяет наличие Germany outbound.
3. Собирает candidate outbound.
4. Вызывает `/panel/xray/testOutbound`.
5. Сохраняет redacted backup template в SQLite.
6. Обновляет Xray-template.
7. Вызывает `/panel/api/server/restartXrayService`.
8. Создаёт недостающие подписочные профили.

При ошибке бот выполняет компенсирующий rollback. Backup остаётся в SQLite для
ручной диагностики.

## Smoke-test после добавления

После первого добавления региона:

1. Обновите подписку клиента.
2. Убедитесь, что появился профиль вида `🇨🇿-ilya-cz-prague`.
3. Подключитесь к новому профилю.
4. Проверьте внешний IP.
5. Откройте несколько обычных сайтов.
6. Проверьте загрузку файла больше `1 MiB`.
7. Переключитесь на старый device-профиль и убедитесь, что он всё ещё выходит
   через Germany.

## Диагностика

| Симптом | Вероятная причина | Действие |
| --- | --- | --- |
| `Compatibility check failed` | Неверный URL, логин, пароль, inbound ID или GE tag. | Запустите `docker compose run --rm bot bun index.ts --check`, затем проверьте `.env`. |
| HTTPS certificate error | Панель использует недоверенный сертификат. | Установите сертификат доверенного CA и проверьте полный `XUI_BASE_URL`. |
| В UI outbound есть, но IP остаётся Germany | Xray-template сохранён, но runtime не перезапущен либо профиль старый. | Обновите образ бота, выполните Repair и переподключите профиль. |
| IP нужной страны виден, но страницы висят в `pending` | Потеря UDP framing или слишком большой MTU во вложенном NordLynx chain. | Убедитесь, что outbound содержит `transportLayer: true`, `noKernelTun: true`, `mtu: 1280`; затем Repair. |
| Высокая задержка NordVPN | Перегруженный или далёкий hostname. | Выполните автоматический Repair либо выберите hostname вручную. |
| Новый пользователь не получил профиль | Новый `subId` ещё не синхронизирован. | Выполните `/sync`. |
| `/sync` сообщает collision | Два `subId` нормализуются в одинаковый slug. | Переименуйте один `subId` в панели и повторите `/sync`. |
| NordVPN menu disabled | Не задан или неверен `NORDVPN_PRIVATE_KEY`. | Проверьте base64 private key в `.env` и перезапустите контейнер. |

## Что видно в клиентских логах

Клиент v2rayN видит только первый hop:

```text
transport/internet/tcp: dialing TCP to tcp:banana.example.com:443
proxy/vless/outbound: tunneling request ... via banana.example.com:443
```

Это нормально. Внутренние hops `RU -> GE -> NordVPN` создаются Xray на
RU-сервере и не отображаются в логах клиентского приложения.

## Проверка контейнера

```bash
docker compose ps
docker compose logs --tail=200 bot
docker compose run --rm bot bun index.ts --check
```

Если изменили `.env`, пересоздайте контейнер:

```bash
docker compose up -d --force-recreate
```
