# CPU描画比較の再現

Windows、Node.js 22以降、Google Chrome、PowerShellを使用します。追加パッケージは不要です。リポジトリのルートから、別々のターミナルで実行します。

```powershell
node benchmarks/cpu-benchmark-server.mjs --port=4192 --baseline=646037c
node benchmarks/cpu-headless-driver.mjs --duration=20000
```

通常・EEW警報・津波を各20秒ずつ、変更前・変更後の順で測定します。手動確認ページは [localhost:4192](http://127.0.0.1:4192/) です。短い確認には `--cases=normal --duration=5000`、逆順には `--variants=optimized,baseline`、読み上げの別途確認には `--variants=optimized --cases=normal --duration=5000 --speech=true` を指定できます。Chromeの場所が違う場合は `--chrome="C:\path\chrome.exe"` を指定します。

ドライバは固有のテスト用プロファイルでChromeを画面なしで起動します。`--use-angle=swiftshader --enable-unsafe-swiftshader` を付け、**実際のWebGL rendererにSwiftShaderが含まれることを確認してから測定**します。確認できなければ失敗として終了します。既存ブラウザの設定・プロファイルは変更せず、終了時は専用プロセスだけを閉じます。結果・プロセス記録・プロファイルは `benchmarks/cpu-headless/<固有名>/` に保存し、上書き・削除しません。ページからの結果保存先は `benchmarks/cpu-results/` です。両方ともGit管理対象外で、個人パスやプロセス情報を含むraw結果を公開する必要はありません。

比較元は `646037c` の `docs/runtime-efficiency.js`、変更後は現在の `docs/` です。他のファイルは両条件で共通です。全履歴の比較ではなく、今回の描画変更を比較します。測定中はソースを編集・ビルド・コミットしないでください。HEADと主要ソースのSHA-256を開始・終了時に記録し、相違があれば結果を無効にします。画面は1280×720・DPR1に固定し、同時の高負荷処理は避けます。

両条件の最終描画上限は15fpsです。変更前は計測フックで15fpsに制限し、変更後はアプリ側の15fps制限を使います。計測フック側は0にして二重制限を避けます。元VMの処理周期・受信・時計・音声は止めません。`renderer.draw` の呼出数と、実際にキャンバスを描いた `_drawThese` のフレーム数を分けて保存します。CPUが追いつかない場合、実測fpsは上限を下回ります。

JS処理時間はCPU時間とは別に記録します。CDPの`threadTicks`はrendererのmain thread、ProcessTimeはrendererプロセスを対象とし、別プロセスのSwiftShaderは含みません。そのため専用Chromeルートと子プロセスをWindows側でも追跡し、合計CPU時間の差分を保存します。`CPU秒 ÷ 経過秒 × 100` が**1コアを100%とする値**です。16論理CPUの場合はこれを16で割った値が全体換算です。コードは実際の論理CPU数を記録して換算します。1秒の取得間隔の間に起動・終了した子プロセスは見逃す可能性があり、OS取得の境界時刻も結果に残します。計測用PowerShellや他アプリはこのプロセス合計に含めません。

カメラの自動再生は新しいlocalhostの設定だけで無効にし、動画デコードを除外します。元アプリと追加表示のWebSocketは起動前に模擬接続へ置き換え、コミュニティ履歴は空にします。模擬データの外部送信はありません。時刻は本物のcloud IOと元受信処理を経由し、津波は元の受信procedure、EEWは元VMのメモリ上のリストへ入力します。本番APIからの配信・回線障害・実際の災害情報は検証しません。公式Scratch読み上げサービスへの通信だけは維持し、HTTP成功・音声デコード・再生開始を別途観測します。画面なしのテストでは、人が音声を聞けたことまでは証明できません。

```powershell
node --test tests/cpu-benchmark-harness.test.mjs
```

4件のテストは描画上限とVM/pen処理の独立性、実描画計数、戻り値の保持、時計・津波データの形式を確認します。実VMでの機能保持は測定結果内の`checks`で別に確認します。詳細procedure計測は`--profile-procedures=true`で有効にできますが、追加負荷があるため、標準の比較はfalseです。
