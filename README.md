# UsageAI (AI Usage Dashboard)

Claude等のAIモデルの使用状況を一覧できるWindows向けダッシュボード（モック）です。Electronで構築されています。

## 画面イメージ (Screenshot)

![UsageAI Screenshot](./assets/screenshot.png)

## 特徴 (Features)
- **複数AIの一括管理**: AWS (Kiro), Anthropic (Claude), Google (Gemini), OpenAI (Codex) など、複数のAIベンダーの使用状況や制限を1つの画面で一括確認できます。
- **カスタマイズ可能な表示**: 右上の設定アイコンから、表示するAIベンダーのオン/オフや、表示順序を自由に変更できます。
- **デスクトップアプリ**: Electronを使用したデスクトップアプリケーション。
- **ポータブル版**: Windows向けのポータブル版ビルド（インストール不要の.exe）に対応。

## 使い方 (Usage)

1. アプリを起動すると、各AIの使用状況（現在のセッション制限、週間制限、リセットまでの時間など）がリアルタイムに近い形で一覧表示されます。
2. 情報を手動で更新したい場合は、右上の**「最新情報に更新」**ボタンをクリックします。
3. 右上の**「設定（歯車アイコン）」**をクリックすると設定画面が開き、表示するAIの絞り込みや並び替えが行えます。

## インストールと起動 (Installation & Setup)

1. 依存パッケージをインストールします。
   ```bash
   npm install
   ```
2. アプリケーションを開発モードで起動します。
   ```bash
   npm start
   ```

## ビルド (Build)

Windows向けのポータブル実行ファイル（`.exe`）を作成するには、以下のコマンドを実行します。
ビルドされたファイルは `release/` フォルダに出力されます。

```bash
npm run build:win
```

## プロジェクト構成 (Project Structure)
- `main.js`: Electronのメインプロセス（バックグラウンド処理）
- `renderer.js`: UIなどを制御するレンダラープロセス
- `preload.js`: メインとレンダラーを安全に繋ぐブリッジ
- `index.html`: アプリケーションのメイン画面
- `styles.css`: デザイン・スタイルシート
