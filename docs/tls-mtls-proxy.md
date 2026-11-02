# TLS / mTLS / OCSP 反向代理接入

mobile-testing `serve --http` 能直接终止 TLS/mTLS，也支持 CRL 与证书热加载；但 **OCSP stapling 依赖 TLS 终止端**，Node TLS 没有 stapling API。生产环境建议由 nginx / HAProxy / 云 LB 终止 TLS，mobile-testing 保持 loopback HTTP。

## 拓扑

```text
runner ── HTTPS/mTLS/OCSP ──> nginx :443 ── HTTP loopback ──> AOS serve 127.0.0.1:8765
```

- runner → 代理：HTTPS + 客户端证书；代理负责 OCSP stapling、CRL。
- 代理 → AOS：HTTP loopback；`Authorization` 与 `X-AOS-Host-Id` 必须保留。
- mobile-testing 的 `AOS_HTTP_TLS_*` 在这种部署下不需要设置。

## nginx

示例：[deploy/nginx/aos-mtls.conf](../deploy/nginx/aos-mtls.conf)

关键点：

- `ssl_verify_client on` + `ssl_client_certificate`：强制 runner 客户端证书。
- `ssl_crl`：吊销列表；与 CA 一起轮换。
- `ssl_stapling on` + `ssl_stapling_verify on`：由 nginx 获取并缓存 OCSP 响应。
- `ssl_trusted_certificate`：用于校验 OCSP 响应签名。
- 服务端证书需包含 OCSP AIA；建议签发时带 `OCSP Must-Staple`。
- `client_max_body_size` 覆盖 Web job 结果上传；`proxy_read_timeout` 覆盖长任务。
- HTTP/2 由 `http2 on` 开启；mobile-testing 自身 TLS listener 也支持 HTTP/2 + HTTP/1.1。

## runner

```bash
AOS_RUNNER_CONTROL_URL=https://aos.example.com
AOS_RUNNER_TLS_CA=/etc/aos/tls/runner-ca.crt
AOS_RUNNER_TLS_CERT=/etc/aos/tls/runner.crt
AOS_RUNNER_TLS_KEY=/etc/aos/tls/runner.key
MOBILE_TESTING_RUNNER_JOB_TOKEN=...
```

runner 只信任代理的证书链；客户端证书由代理校验。mobile-testing 的每主机 token / host 绑定仍然生效。

## 自检

一键检查（mTLS 健康检查、无客户端证书拒绝、OCSP stapling；HTTP/2 由 `curl --http2` 手工确认）：

```bash
node scripts/check-tls-proxy.mjs \
  --url https://aos.example.com \
  --ca runner-ca.crt --cert runner.crt --key runner.key
```

使用 `--json` 出结构化结果；`--no-ocsp` 跳过 stapling 检查；`--no-mtls` 跳过无证书拒绝检查。

手工检查：

```bash
# 1. 客户端证书 + OCSP stapling
openssl s_client -connect aos.example.com:443 \
  -servername aos.example.com \
  -cert runner.crt -key runner.key \
  -CAfile runner-ca.crt -status </dev/null

# 2. 健康检查
curl --http2 --cacert runner-ca.crt \
  --cert runner.crt --key runner.key \
  https://aos.example.com/healthz

# 3. 不带客户端证书应握手失败
openssl s_client -connect aos.example.com:443 -servername aos.example.com </dev/null
```

`openssl s_client -status` 应显示 `OCSP Response Status: successful`；若无 stapling，检查证书 AIA、`ssl_trusted_certificate` 和 DNS resolver。

## 轮换

- 服务端证书 / 客户端 CA / CRL：替换文件后 reload 代理（`nginx -s reload`）。
- mobile-testing 直连 TLS 模式：设置 `AOS_HTTP_TLS_RELOAD_MS` 自动重读；CRL 路径 `AOS_HTTP_TLS_CRL`。
- runner 客户端证书轮换需同步更新代理信任的 CA/CRL。

## 边界

- mobile-testing 本身不做 OCSP stapling；必须由 TLS 终止端完成。
- CRL 与 OCSP 二选一或并用；mobile-testing 直连模式只支持 CRL。
- 代理必须保留 runner 鉴权头，且不要缓存 runner 控制面响应。
