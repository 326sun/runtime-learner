# Runtime Self-Learning 傻瓜安装教程

这个插件用于让 Hanako 在本地记录经验、识别重复错误和用户纠正，并把高置信度提示写入自己的 skill。

## 你需要知道的一句话

插件代码安装到：

```text
%USERPROFILE%\.hanako\plugins\hanako-runtime-learner
```

学习数据保存在：

```text
%USERPROFILE%\.hanako\self-learning
```

升级插件时不要删除 `self-learning`，否则学习记录会被清空。

## 普通用户安装步骤

1. 关闭 Hanako。
2. 打开 PowerShell。
3. 复制下面命令：

```powershell
cd $env:USERPROFILE\Downloads
git clone https://github.com/326sun/hanako-runtime-learner.git
cd hanako-runtime-learner
npm run install-plugin
```

看到这些字样就表示安装成功：

```text
Installed to C:\Users\你的用户名\.hanako\plugins\hanako-runtime-learner
OK    manifest.json
OK    index.js
OK    lib/common.js
OK    lib/hana-runtime-compat.js
OK    tools/search.js
OK    skills/self-learning/SKILL.md
```

4. 打开 Hanako。
5. 进入 `设置 -> 插件`。
6. 打开 `允许全权限插件`。
7. 启用 `Runtime Self-Learning`。

## 怎么确认它在工作

在 Hanako 里让 Agent 调用：

```text
hanako-runtime-learner_self_learning_stats
```

或者：

```text
hanako-runtime-learner_self_learning_control
```

参数用：

```json
{ "action": "status" }
```

如果返回里出现下面字段，就是正常：

```text
patterns
injectable
historySnapshots
dataDir
```

## 升级会不会丢数据

不会。安装脚本只替换：

```text
%USERPROFILE%\.hanako\plugins\hanako-runtime-learner
```

不会删除：

```text
%USERPROFILE%\.hanako\self-learning
```

所以旧版本收集到的：

```text
experience_log.jsonl
error_log.jsonl
patterns.json
config.json
turns.jsonl
skill_history/
```

都会被新版本继续读取。

## 升级步骤

进入插件源码目录，执行：

```powershell
git pull
npm run install-plugin
```

不要执行下面这种删除数据的命令，除非你想清空学习记录：

```powershell
Remove-Item -Recurse -Force $env:USERPROFILE\.hanako\self-learning
```

## 删除旧重复目录

如果你以前装过旧版，可能有旧目录：

```text
%USERPROFILE%\.hanako\plugins\runtime-learner
%USERPROFILE%\.hanako\plugins-dev\runtime-learner
```

可以删除：

```powershell
Remove-Item -Recurse -Force $env:USERPROFILE\.hanako\plugins\runtime-learner -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force $env:USERPROFILE\.hanako\plugins-dev\runtime-learner -ErrorAction SilentlyContinue
```

保留新版目录：

```text
%USERPROFILE%\.hanako\plugins\hanako-runtime-learner
```

## 给 Agent 的安装检查清单

安装或升级时必须检查：

1. `manifest.json` 的 `id` 必须是 `hanako-runtime-learner`。
2. 插件目录必须是 `%USERPROFILE%\.hanako\plugins\hanako-runtime-learner`。
3. 若存在旧目录 `runtime-learner`，删除旧目录。
4. 不要删除 `%USERPROFILE%\.hanako\self-learning`。
5. 安装后调用 `self_learning_control` 的 `status`，确认数据目录仍是 `%USERPROFILE%\.hanako\self-learning`。
6. 如需完全卸载插件，只删除插件目录；如需清空学习数据，必须单独征得用户确认。
