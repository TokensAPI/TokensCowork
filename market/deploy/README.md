# 市场服务 CI 部署

沿用现有服务器、项目仓库和 market/server/.env，不新建服务目录，不预装部署脚本，
不需要另建 GitHub Environment。只更新市场服务 4880，不动 Registry、Nginx 或桌面。

## 向管理员索取

> 已有服务器 5.223.77.54:22，账号 wsy，项目按部署记录为 /home/wsy/TokensCowork。
> 请授权 CI 专用 SSH 密钥，并提供经核验的主机公钥记录（known_hosts）。如需专用账号请告知用户名。
> 账号需能拉取项目 origin、写入项目 Git 目录、
> 读取 market/server/.env、无需交互运行 Docker Compose，并允许 GitHub Actions Runner 连接 SSH。
> 我们自己执行 CI 部署，只更新市场服务，保留原数据库及 4880 端口。

管理员只需一次授权，不需要每次部署。Docker 权限相当于主机高权限，
请使用可信专用账号，并保护 master 和工作流修改权限。
服务器拉取 Git 的权限与 CI 登录密钥不同；已有拉取权限可以复用。

## GitHub 配置

Settings → Secrets and variables → Actions，使用仓库级配置：

| 类型 | 名称 | 内容 |
| --- | --- | --- |
| Variable（可选） | MARKET_SSH_HOST | 默认 5.223.77.54 |
| Variable（可选） | MARKET_SSH_PORT | 默认 22 |
| Variable（可选） | MARKET_SSH_USER | 默认 wsy，使用专用账号时覆盖 |
| Variable（可选） | MARKET_DEPLOY_PATH | 默认 /home/wsy/TokensCowork |
| Secret | MARKET_SSH_PRIVATE_KEY | CI 专用私钥 |
| Secret | MARKET_SSH_KNOWN_HOSTS | 经管理员核验的 known_hosts 记录；非默认端口用 [host]:port |

路径支持字母、数字、点、下划线、斜线和短横线，不支持空格。
正常只需配置两个 Secret。默认路径来自之前部署记录，本轮未联网复核；首次连接会检查，
路径不存在就明确失败，不会创建新服务或猜测其他目录。
主机公钥需经可信渠道核验，不盲目信任扫描结果。私钥只放 Secrets，不提交代码。
业务凭证仍只保留在服务器 .env，不需要交给 CI。
缺少配置时测试仍运行，部署明确失败，不会误报上线。

## 使用

提交后打开 Actions → Deploy Market Server → Run workflow，选择 master。
此后 master 的市场服务/部署文件变更自动触发。测试通过后 SSH 执行部署脚本。
原 market.yml 仍是 Cloudflare 兼容入口的独立工作流。

服务器需有 Bash、Git、flock、Docker/Compose v2，并能访问 Git origin 和基础镜像。
须已有运行容器 tokenscowork-market-host 和数据卷 tokenscowork-market-host-data，
此流程不用于空机初始化。保留现有 .env，尤其不要重新生成授权和加密密钥。

## 部署行为

1. fetch master 并核对本次测试的完整 SHA，拒绝过期排队提交。
2. 从该提交提取 market/server 构建，不覆盖现有工作区或未提交文件。
3. 创建 SQLite 一致性备份并验证完整性，再替换 market，复用 .env 和数据卷。
4. 检查内部鉴权接口、市场源、镜像 SHA 和公网管理资源。

运行产物、Compose、备份及 current-sha 保存在 Git 目录的 market-deploy 下，
普通仓库即 <项目>/.git/market-deploy/。无需管理员提前创建，也不污染源码。
每次部署前备份，主机只保留最近 3 份（本次备份必保留），超出的自动删除且不可由该目录恢复。
数据卷 /data/deploy-backups/ 只作临时中转，主机复制成功后清理脚本生成的临时快照，避免双份长期占用。
清理只匹配部署快照文件名，不递归、不删除手动备份或符号链接。
稳定状态约占 3 份数据库快照空间，备份过程中需额外空间。镜像和构建目录不在本清理范围，
仍需磁盘监控及按运维策略维护；数据库异地备份也需另外安排。

构建或备份失败不替换服务；替换后内部检查失败会尝试回退旧镜像。
不自动覆盖数据库，防止丢失新写入；迁移必须向后兼容，破坏性迁移需单独维护方案。
公网检查失败不自动回退，可能是代理/网络问题。
手动回退可使用该次 releases 下的 rollback-compose.yml：
docker compose -f <绝对路径>/rollback-compose.yml up -d --no-build --no-deps market。
若尚未生成该文件，可由运维根据输出的 rollback 镜像修改该次 Compose。
不要执行 down -v，回退后仍需业务验收。

## 本地检查

    npm --prefix market/server run verify
    node --test market/deploy/*.test.mjs

覆盖语法、参数拒绝和部署安全约束，不替代真实服务器部署/回滚演练。
管理员权限配置后成功运行 CI，才能确认生产已部署。
