# Caddy TLS Reverse Proxy Setup

This guide sets up Caddy as a reverse proxy in front of the Express dashboard, encrypting all traffic with TLS.

**Current setup:** Self-signed certificate (bare IP, no domain). Browser will show a security warning on first visit — click "Advanced" > "Proceed" to accept. Traffic is still encrypted.

**To upgrade to Let's Encrypt:** Point a domain at 143.110.130.198, then edit the Caddyfile to use the domain and `tls your@email.com`.

---

## 1. Install Caddy on Ubuntu 24.04

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install caddy
```

Verify:
```bash
caddy version
```

---

## 2. Deploy Caddyfile

```bash
sudo cp /opt/9mm-rebalancer/Caddyfile /etc/caddy/Caddyfile
```

---

## 3. Update .env on VPS

Add or update these variables in `/opt/9mm-rebalancer/.env`:

```env
DASHBOARD_HOST=127.0.0.1
DASHBOARD_ORIGIN=https://143.110.130.198
```

Then restart the dashboard:
```bash
cd /opt/9mm-rebalancer
pm2 restart 9mm-dashboard
```

---

## 4. Start Caddy

```bash
sudo systemctl enable caddy
sudo systemctl start caddy
sudo systemctl status caddy
```

---

## 5. Update Firewall

```bash
# Allow HTTPS
sudo ufw allow 443/tcp

# Allow HTTP (for redirect to HTTPS)
sudo ufw allow 80/tcp

# Optional: block direct access to port 3100 from outside
# (Express now only listens on 127.0.0.1, so this is defense-in-depth)
sudo ufw deny 3100/tcp

sudo ufw status
```

---

## 6. Verify

```bash
# Should return dashboard data over HTTPS (self-signed cert, hence -k)
curl -k https://143.110.130.198/api/config

# Should redirect to HTTPS
curl -I http://143.110.130.198

# Should be refused (Express bound to localhost only)
curl http://143.110.130.198:3100 || echo "Connection refused — correct!"
```

---

## Troubleshooting

### Check Caddy logs
```bash
sudo journalctl -u caddy --no-pager -n 50
```

### Reload Caddyfile after changes
```bash
sudo cp /opt/9mm-rebalancer/Caddyfile /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

### If port 443 is already in use
```bash
sudo lsof -i :443
# Kill the conflicting process or change Caddy's port
```

---

## Upgrading to Let's Encrypt (future)

1. Point a domain (e.g., `dashboard.yourdomain.com`) at 143.110.130.198
2. Edit `/opt/9mm-rebalancer/Caddyfile`:
   ```
   dashboard.yourdomain.com {
       reverse_proxy 127.0.0.1:3100
   }
   ```
3. Update `.env`:
   ```
   DASHBOARD_ORIGIN=https://dashboard.yourdomain.com
   ```
4. Reload: `sudo cp /opt/9mm-rebalancer/Caddyfile /etc/caddy/Caddyfile && sudo systemctl reload caddy`
5. Restart dashboard: `pm2 restart 9mm-dashboard`
