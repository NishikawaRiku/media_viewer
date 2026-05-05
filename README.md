# Media Viewer

ローカルにある画像・動画ファイルを Web ブラウザから手軽に閲覧できるメディアビューアーです。  
`public/` 配下に置いたフォルダを一覧表示し、画像サムネイル・動画プレビューを自動生成します。パスワード認証に対応しており、Tailscale と組み合わせることで外部端末からのアクセスも可能です。

## 動作環境

- Windows 10 / 11（動作確認済み）
- [Node.js](https://nodejs.org/)（最新の LTS バージョン推奨）

## 初期設定

1. [Node.js](https://nodejs.org/) の最新 LTS バージョンをインストールします。
2. `public/` 配下に任意の名前でフォルダを作成し、その中へ表示したい画像・動画ファイルを配置します。

    ```
    public/
    ├── FOLDER_001/
    │   ├── IMAGE_001.jpe
    │   ├── IMAGE_002.jpeg
    │   ├── IMAGE_003.png
    │   ├── IMAGE_004.webp
    │   └── ...
    ├── FOLDER_002/
    │   ├── VIDEO_001.mp4
    │   ├── VIDEO_002.mov
    │   ├── VIDEO_003.gif
    │   ├── VIDEO_004.webm
    │   └── ...
    └── ...
    ```
3. **【任意】** Tailscale 経由で外部端末からアクセスできるようにする場合は、以下の手順で設定します。
    <details>
    <summary>手順を表示</summary>

    1. [Tailscale](https://tailscale.com) を本アプリを動かす OS にインストールし、アカウントへサインインします。
    2. [Tailscale 管理コンソール（DNS）](https://login.tailscale.com/admin/dns) を開き、以下の 2 つを有効化します。
        - **MagicDNS**
        - **HTTPS Certificates**
    3. 本アプリを動かす OS のターミナル（CommandPrompt、PowerShell など）で以下を実行し、Tailnet 内からの HTTPS (443) アクセスをアプリのポート `3080` へ転送します。

        ```
        tailscale serve --bg 3080
        ```
        ※ 転送を停止する場合は `tailscale serve reset` を実行します。
    4. [Tailscale 管理コンソール（Machines）](https://login.tailscale.com/admin/machines) から、対象マシンの **DNS 名** を確認します。形式は次のとおりです。

        ```
        <マシン名>.<Tailnet 識別子>.ts.net
        ```
    5. 確認した DNS 名を `config.json` の `tailnetDomain` に設定します。

        ```json
        {
          "tailnetDomain": "<マシン名>.<Tailnet 識別子>.ts.net"
        }
        ```
    </details>

## 起動方法

プロジェクトのルートにある `boot.bat` を実行してください。起動時には以下の処理が自動で実行されます。

1. Node.js 依存パッケージのインストール（初回のみ）
2. 未生成の画像サムネイル・動画プレビューの生成
3. ポート `3080` でのサーバー起動
4. アクセス先 URL を既定のブラウザで自動表示
    - Tailscale 設定なし：`http://<LAN 内の IP アドレス>:3080`
    - Tailscale 設定あり：`https://<マシン名>.<Tailnet 識別子>.ts.net`

<br>

> **パスワードを変更する場合**  
> `boot.bat` 内のコマンドは `npm start <パスワード>` の形式になっています。末尾の `password` を任意の文字列に書き換えてください。
