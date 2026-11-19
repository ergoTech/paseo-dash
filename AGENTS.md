# paseo-dash — плагін Paseo, сумісний із God Mode

Правила для агентів (Claude Code, Codex), що працюють у цьому репозиторії.

## Правила

### Чого НЕ робити

- **НЕ коміть і не пуш у trunk** (`master`): ні напряму, ні через force-push. У гілку
  задачі коміть і пуш сам, окремий дозвіл користувача на це не потрібен. Мерж у
  trunk робить лише користувач.
- **НЕ коміть жоден коміт без пройденого незалежного ревью** — на будь-якій гілці,
  див. «Ревью перед кожним комітом». Це блокується хуком.
- **НЕ відкривай другий PR на ту саму задачу** і не заводь нову гілку під кожен
  коміт.
- **НЕ мерж PR сам.** Мерж робить користувач.
- **НЕ додавай згадки асистента** — ні `Co-Authored-By: Claude …`, ні
  `🤖 Generated with Claude Code`, ні посилань на сесію. Ніде: ні в повідомленнях
  комітів, ні в описах PR, ні в коментарях до них. Хто написав код — питання
  авторства, а не підпису під ним.
- **НЕ чіпай код, не пов'язаний із задачею** — ні рефакторингу «за компанію», ні
  правок стилю в сусідніх рядках, ні перейменувань поза скоупом.
- **НЕ став нові залежності** без узгодження з користувачем.
- **НЕ пиши код, доки користувач прямо не попросив.** Спершу — план по пунктах.
  Якщо hub-сесія передає агенту в Paseo, що **користувач** попросив реалізувати
  задачу, — це і є пряме прохання; план тоді йде в звіт, а не замість роботи.
- **НЕ чіпай руками `~/.paseo/`** (конфіги демона, `plugins/*/checkout`, ключі).
  Плагіни ставляться, оновлюються й перезавантажуються лише через `paseo plugin …`.
  Ключ демона (`daemon-keypair.json`) і креденшли — повний доступ до Paseo, їх не
  читати, не копіювати, не друкувати.
- **НЕ друкуй значення секретів** у вивід, чат чи логи. Секрети не живуть у git.
- **НЕ вигадуй команди, файли, RPC і документацію, яких немає.** Якщо щось не
  перевірив — скажи, що не перевірив, замість того щоб озвучити правдоподібне.

### Ревью перед кожним комітом

Гейт стосується **кожного коміту на кожній гілці**. Порядок: написав → прогнав
typecheck/тести → **ревью** → полагодив знайдене → і тільки тоді коміт.

Ревью робить **незалежний ревьюер** (окремий сабагент), а не самоперевірка автора.
Знахідки P0/P1 треба полагодити й **переревьюїти**, а не занотувати «на потім».

Технічно це хук `PreToolUse` → `.claude/hooks/review-gate.py` (тести — `python3 .claude/hooks/test_review_gate.py`). Він
друкує в тексті відмови всі потрібні команди. Апрув прив'язаний до фінгерпринту
індексу, робочої теки й untracked-файлів — дописав код після ревью, апрув
анулювався. Обійти можна лише явним
`review-gate.py approve --waive --reason "<слова користувача>"` (у `commit` вейвера
немає), і це лишає слід у логу. Фраза хука «autodeploys to production» для `master` тут не
відповідає дійсності — автодеплою в цьому репо немає, але `master` однаково чіпає
лише користувач.

Гейт мовчить у чотирьох місцях: зміни лише в `.md` і `LICENSE` (але не `AGENTS.md`,
`CLAUDE.md` і `docs/agents/`), коміт усередині зупиненого rebase/merge/cherry-pick/
revert, коміт, репозиторію якого не видно з рядка команди (якщо fallback-тека стоїть
на `master`/`main` — відмова), і внутрішня помилка самого хука — він падає відкрито. **Мовчання гейта — не дозвіл.**

Порядок коміту, кожен крок із літеральним абсолютним шляхом робочої теки `<wt>`:

1. `git -C <wt> add …` — усе, що піде в коміт. Далі нічого не додавай і не правь.
2. `python3 <wt>/.claude/hooks/review-gate.py status --repo <wt>` — візьми звідти
   `fingerprint` (для `--amend` — рядок `amend basis`).
3. Ревьюеру — `git -C <wt> diff --cached` (до першого коміту) або
   `git -C <wt> diff HEAD`, плюс `git -C <wt> status --short` і цей fingerprint. Його
   звіт мусить мати рядки `Fingerprint: <значення>` і `Verdict: APPROVE`. Дописувати
   fingerprint у звіт самому не можна.
4. Звіт ревьюер повертає текстом; автор пише його дослівно у файл **поза** `<wt>`.
5. `python3 <wt>/.claude/hooks/review-gate.py commit --repo <wt> --report <файл> -- -m "…"`
   — записує апрув і робить `git commit`.

### Задача, гілка, PR

Одна задача — одна гілка — один Paseo-workspace — один PR. Комітів у гілці скільки
треба, кожен проходить гейт окремо.

- Хостинг — GitHub, `ergoTech/paseo-dash`, remote `origin`, trunk `master`.
- Перед створенням workspace — `git fetch origin`, гілку задачі створюй від
  `origin/master`. Повертаєшся до вже запушеної гілки — бери саме її, а не нову.
- Перший пуш: `git push -u origin <гілка>`, далі одразу
  `gh pr create --draft --base master --title "…" --body "…"` (без `--title`/`--body`
  неінтерактивний запуск зупиняється; у тілі — жодних згадок асистента).
- Фікси за ревью PR і доробки — нові коміти в ту саму гілку, звичайний `git push`.
- Наприкінці кожної сесії все закомічене має бути запушене, а у звіті користувачу —
  посилання на PR. Робота триває — PR лишається Draft. Draft знімай лише коли робота
  завершена повністю (усе запушено, typecheck і тести зелені): `gh pr ready <номер>`.
- Після першого пушу історію гілки не переписуй (без force-push). Master пішов уперед —
  `git merge origin/master` у гілку, до `git add` і ревью. До першого пушу —
  `git rebase --autostash origin/master`.
- Повідомлення комітів — conventional prefixes (`feat:`, `fix:`, `chore:`, `docs:`,
  `refactor:`, `test:`), англійською.

### Робота в Paseo

- Задача живе у власному worktree-workspace репозиторію, не в основному checkout:
  основний checkout може стояти на гілці іншої сесії. Тебе запустили в основному
  checkout — скажи про це користувачу, перш ніж комітити.
- Diff для ревьюера — від `HEAD`, не від `origin/master`: master рухається, і чужі
  коміти виглядатимуть як видалення.
- Гілку задачі пушить та сесія, яка в ній комітила. Класифікатор відмовив у
  `git push` — не обходь відмову, а поверни команду пушу батьківській сесії (або
  користувачу).

### Перевірка мусить дивитись туди, де ламається

Зелений сигнал із місця, куди дефект не дістає, гірший за відсутність перевірки: він
перетворює «не знаю» на впевнену неправду. Це стосується і автора, і ревьюера —
знахідка ревьюера це доказ, а не факт.

Перед тим як повірити перевірці, назви вголос, **де живе те, що ламається**, і
переконайся, що перевірка йде звідти. Для цього проєкту це означає:

- `tsc --noEmit` і `node --test` не доводять, що плагін вантажиться в Paseo. Плагін
  живе в демоні: перевірка — `paseo plugin reload <id>` + `paseo plugin logs <id>`
  на реальному демоні, а не лише зелений typecheck.
- Що God Mode бачить плагін — перевіряється викликом `meta.describe` через Paseo, а
  не читанням власного коду.
- `"dry run"` пишемо тільки коли він у інструмента є. Звір із `--help`.
- **Знахідку ревьюера відтвори проти джерела, перш ніж застосовувати.**
- **Коли фікс відкриває наступну поломку — зупинись і сформулюй інваріант**, а не
  лагодь по нозі за раз.

Цифри в коментарях — зобовʼязання. Якщо число неможливо переміряти — краще прибрати
число, ніж уточнити його.

## Що будуємо

Плагін Paseo **Paseo Dash** (коротко PD; id `dashboard`), який інтегрується з **God Mode** та іншими встановленими
плагінами Paseo. Дизайн v1 (task manager з картою-метро, репо планів, контракт God
Mode) погоджено з користувачем і лежить у `docs/design/task-manager-v1/`; роботу
ведемо фазами з `07-plan.md`, кожна фаза — окрема задача і PR.

### Референси (читати перед проєктуванням)

- **Skill `paseo-plugin`** — завантаж його перед будь-якою роботою з плагіном
  (хуки, screen/sidebar/panel, Command Center, RPC, timeline). Skill `paseo` — для
  керування агентами/workspace через MCP або CLI.
- **God Mode** — `github.com/devXpro/paseo-god-mode-plugin`; встановлена копія:
  `~/.paseo/plugins/god-mode/*/checkout` (лише читати). Ключові доки там:
  - `docs/plugin-capabilities.md` — контракт `paseo.capabilities/1`
    (`outcome`, `target`, `untrusted`);
  - `docs/plugin-authoring.md` — як реалізувати RPC `meta.describe`, щоб God Mode
    (і ChatGPT через нього) міг читати плагін і діяти через нього;
  - `docs/plugin-tools.md` — `plugin_read` / `plugin_action`;
  - `docs/architecture.md`, `docs/security.md`.
- Встановлені плагіни — авторитетний список дає `paseo plugin ls` (статус, джерело,
  тека). `~/.paseo/plugins/sources.json` показує лише git-джерела, без локальних
  плагінів. Структура плагіна —
  як у God Mode: `paseo-plugin.json`, `index.server.ts`, `index.client.tsx`,
  `server/`, `client/`, `shared/`.
- Інші локальні плагіни для порівняння — у `paseo plugin ls` (стовпець теки).

### Що важливо про плагіни Paseo

- Плагіни **trusted і unsandboxed**: код сервера виконується в демоні з правами
  користувача. Помилка в `contribute()` валить увесь плагін — важкі речі (рендер
  схем тощо) роби ліниво, в обробнику RPC.
- Paseo сам постачає `zod` у серверні бандли плагінів (за доками God Mode — zod
  4.4.3 у Paseo 0.11.4; для 0.13 не перевірено); контракти RPC — через `defineRpc`
  із `@getpaseo/plugin`, і ті самі zod-схеми рендерять `meta.describe`, щоб опис не
  обіцяв аргумент, який хендлер відкине.
- Paseo перестає чекати RPC плагіна через 30 секунд, хендлер при цьому не
  зупиняється (за доками God Mode для 0.11; для 0.13 не перевірено) — довгі операції
  мають бути асинхронними.
- Paired-клієнт може викликати **будь-який** RPC плагіна: `meta.describe` — не
  система дозволів. Небезпечні дії захищай у самому хендлері.
- Інсталяція з git (`paseo plugin add git:…`) сама залежностей **не ставить**: це робить
  `"build": [["npm", "ci", "--omit=dev", "--ignore-scripts"]]` у `paseo-plugin.json` (тому
  `package-lock.json` мусить бути синхронним). Збірка Paseo відкидає навіть `import type` з
  пакета, якого немає серед установлених `dependencies`. Без цього проходять лише модулі хоста
  (`@getpaseo/plugin`, `@getpaseo/plugin/server` і решта перелічених SDK-входів, `zod`, `react`,
  `react-native`, `@tanstack/react-query`), вбудовані модулі Node і **type-only** імпорти
  `@getpaseo/protocol/*`; тип API Paseo бери з `server/paseo.ts`, не з `@getpaseo/client`.
  `dashboard-dev` з `node_modules` поруч цього не ловить — перевірка: `shared/boundaries.test.ts`
  і живе `paseo plugin add file:///<bare-репо> --id <тимчасовий id>` чистої копії.

## Команди й оточення

- Paseo на цій машині — демон і CLI `0.15.4` (звірено `paseo --version` і `paseo daemon status --json`
  2026-11-13), CLI `paseo` (`~/.local/bin/paseo`). Перевірено на 0.15.4 того ж дня:
  `paseo plugin init <dir>` (створює typecheckable локальний плагін),
  `paseo plugin add <source>` (registry / тека / git / npm),
  `paseo plugin reload|logs|enable|disable|remove <id>`, `paseo plugin ls`.
- Плагін — у корені репо (id `dashboard`, `requirements.paseo >=0.13.0`). Звірені
  команди, з кореня worktree:
  - `npm install` — dev-залежності (SDK `@getpaseo/plugin` запінений рівно на `0.13.0`: PD ставиться на
    Paseo від 0.13, тож typecheck іде проти найстаршого API. Хуки — лише через `server/hooks.ts`
    (`onHook`/`beforeHook`): на 0.15+ вони йдуть через `addHook` з новими назвами, бо `server.on` і
    `server.before` там deprecated і «removed after 2027-04-30»);
  - `npm run typecheck` — `tsc --noEmit` (тести `*.test.ts` теж typecheck-аються);
  - `npm test` — `node --test` (Node 22.18+ з type stripping; на машині Node 25);
  - `GODMODE_CHECKOUT=<окремий клон God Mode> npm test` — ще й прогін опису через
    `parseCapabilities` самого God Mode. Клон — не копія під `~/.paseo`
    (`git clone --depth 1 --branch v0.12.1 https://github.com/devXpro/paseo-god-mode-plugin <dir>`);
    без змінної ці тести пропускаються. `server/api/godmode.test.ts` ганяє справжні
    `pluginReadOn`/`pluginActionOn` з `gpt-site/core/paseo.mjs`, а їм потрібні
    `@getpaseo/protocol` і `@getpaseo/client`: без встановлених залежностей клону
    скопіюй `gpt-site/core` в окрему теку `<dir>/gpt-site/core` і поклади поруч симлінк
    `<dir>/gpt-site/node_modules` → `node_modules` цього worktree (там 0.13.0); інакше тест
    пропускається з причиною.
- `node fixtures/large-plan.ts [тека]` — генерує репо планів на 500 задач у 6 проєктах (простір
  `LPL`) для ручної перевірки екранів; друкує bare-remote, який підключається в Settings → Paseo Dash.
- `npm run sizes [-- <base-ref>]` — таблиця для PR: розміри `meta.describe`, `overview`, `tasks`, `task` на large-plan у робочому дереві й у base (типово `origin/master`, із fetch). Бюджет — `fixtures/response-budget.ts`, його перевіряє `npm test`; підіймати лише явно в PR.
- Жива перевірка в демоні: `dashboard-dev` вказує на теку одного worktree. У новому
  worktree спершу `paseo plugin ls` — якщо `dashboard-dev` дивиться на старий, то
  `paseo plugin remove dashboard-dev` (локальну теку він не видаляє), потім
  `paseo plugin add <абсолютний шлях worktree> --id dashboard-dev`; після правок —
  `paseo plugin reload dashboard-dev`, `paseo plugin ls` (статус `running`, без ERROR) і
  `paseo plugin logs dashboard-dev`. Демон не перезапускати.
- Назва для людей — `PLUGIN_NAME` із `shared/edition.ts`, не літерал: інсталяція з git — **Paseo Dash**,
  робоча копія — **Paseo Dash Dev**. Paseo не каже плагіну, під яким id він працює, тож edition пише
  `scripts/edition.mjs` у gitignored `shared/edition.generated.ts`: `npm install` (postinstall) —
  `dev`, останній крок `build` у `paseo-plugin.json` — `release`. Без цього файлу typecheck, тести й
  `paseo plugin reload dashboard-dev` падають на імпорті — у робочій копії спершу `npm install`.
  Аліас «PD» і загальні слова в `meta.describe` має лише release (`identity()` у
  `server/capabilities.ts`): God Mode бере перший збіг, і dev не мусить перехоплювати «PD». У списку
  плагінів Paseo обидві копії звуться за маніфестом (Paseo Dash), розрізняє їх id.
  Технічні ідентифікатори старої назви не міняти: id `dashboard`, `plugin-data/dashboard`, MCP-сервер
  агентів `dashboard`, трейлер `Dashboard-Op` у комітах плану, topic `paseo-dashboard-plan`.
- Python — **`python3`**, ніколи `python`.
- GitHub — через `gh`.
- Не гидуй ходити в інтернет і в context7 по MCP за прикладами й документацією,
  якщо розумієш, що твоєї бази знань недостатньо.

## Мова

- Код, коментарі до коду, документація, коміти й PR — **англійською**, нейтральним тоном.
- Особисті правила мови й тону для чату (та шляхи цієї машини) живуть поза git, у
  `~/.claude/paseo-dashboard-local.md`; Claude Code підтягує їх рядком нижче, якщо файл є.

@~/.claude/paseo-dashboard-local.md
