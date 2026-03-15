# Manual Deployment Guide for DigitalOcean VPS

**VPS IP**: 143.110.130.198
**SSH User**: tyler (root login disabled)
**Project Path**: /opt/9mm-rebalancer

## Quick Start - Copy/Paste Commands

Log into your VPS using the DigitalOcean console or SSH:

```bash
ssh tyler@143.110.130.198
```

Then copy and paste these commands **one section at a time**:

---

## 1. Check Environment

```bash
echo "=== Checking system environment ==="
node --version 2>/dev/null || echo "Node.js not installed"
npm --version 2>/dev/null || echo "npm not installed"
pm2 --version 2>/dev/null || echo "PM2 not installed"
git --version 2>/dev/null || echo "git not installed"
df -h /
```

---

## 2. Install Node.js (if not installed)

```bash
# Install Node.js 20.x
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Verify
node --version
npm --version
```

---

## 3. Install PM2 (if not installed)

```bash
npm install -g pm2

# Verify
pm2 --version

# Check existing PM2 processes
pm2 list
```

---

## 4. Install Git (if not installed)

```bash
sudo apt-get update
sudo apt-get install -y git

# Verify
git --version
```

---

## 5. Clone Repository

```bash
# Create project directory
mkdir -p /opt/9mm-rebalancer
cd /opt/9mm-rebalancer

# Clone repository
git clone https://github.com/TylerB007/ALM-For-9MM-Pulsechain.git .

# Verify
ls -la
```

---

## 6. Install Dependencies and Build

```bash
cd /opt/9mm-rebalancer

# Install dependencies
npm ci

# Build TypeScript
npm run build

# Verify build succeeded
ls -la dist/index.js
```

---

## 7. Create .env File (IMPORTANT - Contains Private Key)

**⚠️ SECURITY CRITICAL: Never share your private key!**

```bash
cd /opt/9mm-rebalancer

# Create .env file with secure permissions
touch .env
chmod 600 .env

# Edit the file
nano .env
```

**Add this content** (replace `YOUR_PRIVATE_KEY_HERE` with your actual private key):

```env
PRIVATE_KEY=0xYOUR_PRIVATE_KEY_HERE
RPC_URL_PRIMARY=https://rpc.pulsechain.com
RPC_URL_FALLBACK_1=https://rpc-pulsechain.g4mm4.io
RPC_URL_FALLBACK_2=https://pulsechain-rpc.publicnode.com
```

**Save and exit**: Press `Ctrl+X`, then `Y`, then `Enter`

**Verify permissions**:
```bash
ls -la .env
# Should show: -rw------- (600)
```

---

## 8. Verify Configuration

```bash
cd /opt/9mm-rebalancer

# Check config.yaml settings
cat config.yaml | grep -E "token_id|dry_run"
```

**Verify**:
- `token_id: 155181` (your NFT position)
- `dry_run: true` (safe mode for first run)

---

## 9. Create Log Directories

```bash
cd /opt/9mm-rebalancer
mkdir -p logs
```

---

## 10. Start Application with PM2

```bash
cd /opt/9mm-rebalancer

# Start the application
pm2 start ecosystem.config.cjs

# Check status
pm2 list
pm2 show 9mm-rebalancer
```

---

## 11. Monitor Logs

```bash
# Watch PM2 logs in real-time
pm2 logs 9mm-rebalancer

# Or check last 50 lines
pm2 logs 9mm-rebalancer --lines 50

# Or check Winston application logs
tail -f /opt/9mm-rebalancer/logs/rebalancer.log
```

**Expected output**:
```
✓ 9mm V3 LP Auto-Rebalancer starting...
✓ Connected to PulseChain (chain ID 369)
✓ Wallet: 0x43FE...9647
✓ Wallet PLS balance: XXXXX.XX PLS
✓ Position #155181: HEX/WPLS | [IN/OUT OF] RANGE
✓ Starting monitoring loop (interval: 30s)
```

**Press `Ctrl+C` to stop watching logs**

---

## 12. Configure Auto-Start on Reboot

```bash
# Generate startup script
pm2 startup

# It will output a command like this - COPY AND RUN IT:
# sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u root --hp /root

# After running that command, save PM2 process list
pm2 save

# Verify
systemctl status pm2-root
```

---

## 13. Install Log Rotation

```bash
# Install PM2 log rotation module
pm2 install pm2-logrotate

# Configure rotation
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 10
pm2 set pm2-logrotate:compress true
pm2 set pm2-logrotate:rotateInterval '0 0 * * *'

# Verify
pm2 conf pm2-logrotate
```

---

## 14. Test Dry Run Mode (Monitor for 2-3 Minutes)

```bash
# Watch logs for 2-3 monitoring cycles (60-90 seconds)
pm2 logs 9mm-rebalancer --lines 100

# Press Ctrl+C when done watching
```

**Verify**:
- ✅ Position status is fetched correctly
- ✅ No errors in logs
- ✅ Monitoring loop runs every 30 seconds
- ✅ If position is out of range, dry-run rebalance is logged (no real transaction)
- ✅ Telegram notifications work (if enabled)

---

## 15. Create Health Check Script

```bash
cat > ~/check-9mm-health.sh << 'EOF'
#!/bin/bash
echo "=== 9mm Rebalancer Health Check ==="
echo ""
echo "1. PM2 Status:"
pm2 show 9mm-rebalancer | grep -E "status|uptime|restarts|memory"
echo ""
echo "2. Recent Errors:"
ERROR_COUNT=$(grep -c "ERROR" /opt/9mm-rebalancer/logs/rebalancer.log 2>/dev/null || echo 0)
echo "Total errors in log: $ERROR_COUNT"
if [ $ERROR_COUNT -gt 0 ]; then
  tail -100 /opt/9mm-rebalancer/logs/rebalancer.log | grep ERROR | tail -5
fi
echo ""
echo "3. Last Monitoring Cycle:"
tail -50 /opt/9mm-rebalancer/logs/rebalancer.log | grep "Position #" | tail -1
echo ""
echo "4. Disk Space:"
df -h ~ | tail -1
echo ""
EOF

chmod +x ~/check-9mm-health.sh

# Run health check
~/check-9mm-health.sh
```

---

## 16. Enable HTTPS (TLS via Caddy Reverse Proxy)

See **[docs/caddy-setup.md](docs/caddy-setup.md)** for full instructions.

Quick summary:

```bash
# Install Caddy
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install caddy

# Deploy config
sudo cp /opt/9mm-rebalancer/Caddyfile /etc/caddy/Caddyfile
sudo systemctl enable caddy && sudo systemctl start caddy

# Update .env
# Add: DASHBOARD_HOST=127.0.0.1
# Add: DASHBOARD_ORIGIN=https://143.110.130.198

# Restart dashboard + open firewall
pm2 restart 9mm-dashboard
sudo ufw allow 443/tcp && sudo ufw allow 80/tcp
```

Dashboard is now at `https://143.110.130.198` (self-signed cert — accept browser warning on first visit).

---

## Common PM2 Commands

```bash
# View all processes
pm2 list

# Show detailed info
pm2 show 9mm-rebalancer

# View logs
pm2 logs 9mm-rebalancer
pm2 logs 9mm-rebalancer --lines 100
pm2 logs 9mm-rebalancer --err  # errors only

# Restart
pm2 restart 9mm-rebalancer

# Stop (keeps in PM2 list)
pm2 stop 9mm-rebalancer

# Start (if stopped)
pm2 start 9mm-rebalancer

# Remove from PM2
pm2 delete 9mm-rebalancer

# Real-time monitoring
pm2 monit

# Save process list
pm2 save
```

---

## Update Deployment (Pull Latest Changes)

```bash
cd /opt/9mm-rebalancer
git pull origin main
npm ci
npm run build
pm2 restart 9mm-rebalancer
pm2 save
```

---

## Enable Production Mode (After Testing!)

**⚠️ ONLY after successful dry-run testing!**

```bash
cd /opt/9mm-rebalancer

# Edit config
nano config.yaml

# Change: dry_run: false
# Save: Ctrl+X, Y, Enter

# Restart
pm2 restart 9mm-rebalancer

# Monitor closely for first real rebalance
pm2 logs 9mm-rebalancer --lines 100
```

---

## Troubleshooting

### View All Logs
```bash
pm2 logs 9mm-rebalancer --lines 200
tail -100 /opt/9mm-rebalancer/logs/rebalancer.log
tail -50 /opt/9mm-rebalancer/logs/error.log
```

### Test Manually (Without PM2)
```bash
pm2 stop 9mm-rebalancer
cd /opt/9mm-rebalancer
node dist/index.js  # Run directly to see errors
# Press Ctrl+C to stop
pm2 start 9mm-rebalancer  # Restart with PM2
```

### Check Process Resources
```bash
pm2 show 9mm-rebalancer
ps aux | grep "dist/index.js"
htop  # Interactive process viewer (may need to install: apt install htop)
```

### Update Private Key
```bash
cd /opt/9mm-rebalancer
nano .env  # Update PRIVATE_KEY
pm2 restart 9mm-rebalancer
pm2 logs 9mm-rebalancer --lines 20  # Verify new key works
```

---

## Deployment Checklist

### ✅ Pre-Deployment
- [x] PM2 ecosystem config created and pushed to GitHub
- [x] VPS credentials obtained (143.110.130.198, root)
- [x] SSH access working (password changed)

### ✅ Environment Setup
- [ ] Node.js >= 18.0.0 installed
- [ ] PM2 installed globally
- [ ] Git installed
- [ ] Disk space > 1GB free

### ✅ Deployment
- [ ] Repository cloned to `/opt/9mm-rebalancer`
- [ ] Dependencies installed (`npm ci`)
- [ ] Built successfully (`npm run build`)
- [ ] `dist/index.js` exists

### ✅ Configuration
- [ ] `.env` file created with correct `PRIVATE_KEY`
- [ ] `.env` permissions = 600
- [ ] `config.yaml` reviewed (token_id=155181, dry_run=true)
- [ ] Log directories created

### ✅ PM2 Running
- [ ] Started with `pm2 start ecosystem.config.cjs`
- [ ] `pm2 list` shows status "online"
- [ ] Logs show successful startup
- [ ] Wallet connected and balance checked
- [ ] Position status displayed

### ✅ Testing
- [ ] Dry run mode tested (2-3 monitoring cycles)
- [ ] No errors in logs
- [ ] Telegram notifications working
- [ ] Health check script passes

### ✅ Persistence
- [ ] `pm2 startup` configured
- [ ] `pm2 save` executed
- [ ] PM2 log rotation installed

### ✅ Production (Optional - After Testing)
- [ ] Dry run disabled (`dry_run: false`)
- [ ] Restarted and monitored
- [ ] First rebalance confirmed successful

---

## Quick Reference

| Task | Command |
|------|---------|
| SSH to VPS | `ssh tyler@143.110.130.198` |
| Project directory | `cd /opt/9mm-rebalancer` |
| View PM2 processes | `pm2 list` |
| View bot logs | `pm2 logs 9mm-rebalancer` |
| View dashboard logs | `pm2 logs 9mm-dashboard` |
| Restart bot | `pm2 restart 9mm-rebalancer` |
| Restart dashboard | `pm2 restart 9mm-dashboard` |
| Stop bot | `pm2 stop 9mm-rebalancer` |
| Update & deploy | `cd /opt/9mm-rebalancer && git pull origin main && npm install && npx tsc && cd src/web && npm install && npm run build && cd ../.. && pm2 restart 9mm-rebalancer && pm2 restart 9mm-dashboard` |

---

## Support

If you encounter issues:
1. Check logs: `pm2 logs 9mm-rebalancer --err --lines 50`
2. Run health check: `~/check-9mm-health.sh`
3. Check this guide: `cat /opt/9mm-rebalancer/DEPLOY_MANUAL.md`

**Estimated deployment time**: 15-25 minutes for first-time setup
