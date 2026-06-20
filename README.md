# 決鬥力場 後端伺服器 — 部署說明

這個後端**完全不需要安裝任何 npm 套件**，只用 Node.js 內建模組寫成（http / crypto / fs），所以部署起來非常單純：只要目標環境有 Node.js，就能直接執行，不會遇到套件安裝失敗或版本不相容的問題。

## 本機測試

```bash
node server.js
```

預設會在 `http://localhost:3001` 啟動。資料存在同一個資料夾下的 `duel-db.json` 這個檔案（第一次啟動會自動建立），重啟伺服器資料不會不見。

可以先用瀏覽器打開 `http://localhost:3001/api/health`，看到 `{"ok":true}` 就代表正常運作。

## 部署到雲端（讓朋友連得到）

推薦用免費的 PaaS 服務，因為它們會幫你處理「24小時保持運作」這件事，不需要自己顧著電腦開機：

### 方式一：Render（推薦，操作最簡單）
1. 把這個 `server` 資料夾放進一個 GitHub repo
2. 到 [render.com](https://render.com) 註冊，選「New Web Service」
3. 連接你的 GitHub repo
4. Build Command 留空，Start Command 填 `node server.js`
5. 部署完成後會拿到一個網址，例如 `https://你的服務名稱.onrender.com`

### 方式二：Railway / Fly.io
流程大同小異：連 GitHub repo → 設定啟動指令為 `node server.js` → 部署。

### 環境變數（建議在雲端平台上設定，不要寫死在程式碼裡）
| 變數 | 說明 | 範例 |
|---|---|---|
| `PORT` | 伺服器監聽的port，大部分雲端平台會自動注入，不用自己設 | （通常不用填） |
| `JWT_SECRET` | 登入token的簽章密鑰，**正式上線前務必自己設一組**，不要用程式碼裡的預設值 | 一串隨機英數字，例如用 `openssl rand -hex 32` 產生 |
| `DB_PATH` | 資料庫檔案路徑，預設存在程式同層資料夾即可 | （通常不用填） |

> ⚠️ 注意：免費方案的雲端平台通常**檔案系統不是永久保存的**（重新部署或休眠喚醒後可能會重置），意味著 `duel-db.json` 裡的帳號資料可能會不見。如果之後使用者變多、想要資料長期穩定保存，建議升級成有「persistent disk」的方案，或换成真正的雲端資料庫服務。目前這個版本適合先拿來跟朋友測試玩。

## 把網址接到網頁前端

部署完成拿到網址後，打開 `duel_field.html`，找到最上面這一行：

```js
const API_BASE = 'http://localhost:3001';
```

改成你部署後的網址（注意**不要加結尾的斜線 `/`**），例如：

```js
const API_BASE = 'https://你的服務名稱.onrender.com';
```

存檔後重新上傳 `duel_field.html` 到你原本放網頁的地方（例如 Netlify）就完成了。

## API 一覽

| Method | Path | 需要登入 | 說明 |
|---|---|---|---|
| POST | `/api/auth/register` | 否 | 註冊，body：`{username, password}` |
| POST | `/api/auth/login` | 否 | 登入，body：`{username, password}`，回傳 `{token, username}` |
| GET | `/api/me` | 是 | 取得自己的個人資料與戰績 |
| GET | `/api/leaderboard?limit=20` | 否 | 排行榜（依勝場數排序） |
| POST | `/api/match/report` | 是 | 回報一場對戰結果，body：`{matchUuid, opponentUsername, result, charKey, fieldKey}`，result為 `win`/`lose`/`draw` |
| GET | `/api/match/history?limit=20` | 是 | 自己的對戰紀錄 |
| POST | `/api/friends/request` | 是 | 送出好友邀請，body：`{toUsername}` |
| POST | `/api/friends/respond` | 是 | 回應好友邀請，body：`{requestId, accept}` |
| GET | `/api/friends` | 是 | 好友清單、收到/送出的邀請 |

需要登入的 API，請在 header 帶上 `Authorization: Bearer <登入時拿到的token>`。

## 已知限制（之後可以再迭代）

- **對戰結果是由前端各自回報的**，伺服器沒有重新驗證整場對戰過程，理論上有心人士可以竄改戰績。這個設計適合好友間的休閒對戰；如果之後想做嚴謹的競技排名，需要把對戰結算邏輯也搬到伺服器上做驗證。
- 目前資料庫是單一 JSON 檔案，適合小規模使用；使用者數量變多後建議換成正式資料庫（例如 SQLite、PostgreSQL）。
