/* pty-echo.c —— ss-board-bridge 联调辅件：无真实 UART 环境（QEMU/容器）的虚拟串口
 *
 * 创建一个 PTY 对：ss-board-bridge 把 PTY 从端当串口打开，本程序持主端模拟"设备"：
 *   - 桥写到从端的数据（= 发往设备的 TX）→ 以 hex 追加到 <base>.log（行格式 TX:<hex>）
 *   - 写入 FIFO <base>.in 的数据 → 经主端注入（= 设备的 RX），桥会推给 hub；同时记 IN:<hex>
 *   - PTY 从端路径写入 <base>.slave（启动后 cat 一下拿路径）
 *
 * 用法（默认 base=/tmp/pty，可换）：
 *   ./pty-echo &
 *   ./ss-board-bridge-x64 --listen 0.0.0.0:18700 --port ttyS1=$(cat /tmp/pty.slave)
 *   # 在 serial-studio 终端里敲字 → cat /tmp/pty.log 看 TX
 *   printf 'OK\r\n' > /tmp/pty.in        # 模拟设备回话 → serial-studio 终端应显示 OK
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <errno.h>
#include <unistd.h>
#include <fcntl.h>
#include <sys/select.h>
#include <sys/stat.h>
#include <pty.h>

static FILE *logf;

static void log_hex(const char *tag, const uint8_t *p, size_t n) {
    fprintf(logf, "%s:", tag);
    for (size_t i = 0; i < n; i++) fprintf(logf, "%02x", p[i]);
    fprintf(logf, "\n");
    fflush(logf);
}

int main(int argc, char **argv) {
    const char *base = argc > 1 ? argv[1] : "/tmp/pty";
    char path[256];

    int mfd = posix_openpt(O_RDWR | O_NOCTTY);
    if (mfd < 0) { perror("posix_openpt"); return 1; }
    if (grantpt(mfd) != 0 || unlockpt(mfd) != 0) { perror("grantpt/unlockpt"); return 1; }
    char *slave = ptsname(mfd);
    if (!slave) { perror("ptsname"); return 1; }

    snprintf(path, sizeof path, "%s.slave", base);
    FILE *f = fopen(path, "w");
    if (!f || fprintf(f, "%s\n", slave) < 0 || fclose(f) != 0) { perror("write .slave"); return 1; }
    printf("PTY slave: %s (written to %s)\n", slave, path);

    snprintf(path, sizeof path, "%s.in", base);
    unlink(path);
    if (mkfifo(path, 0666) != 0) { perror("mkfifo"); return 1; }
    /* O_RDWR 打开 FIFO：无写入者时也不会 EOF，select 稳定 */
    int ffd = open(path, O_RDWR | O_NONBLOCK);
    if (ffd < 0) { perror("open fifo"); return 1; }

    snprintf(path, sizeof path, "%s.log", base);
    logf = fopen(path, "w");
    if (!logf) { perror("open log"); return 1; }

    uint8_t buf[4096];
    for (;;) {
        fd_set rs;
        FD_ZERO(&rs);
        FD_SET(mfd, &rs);
        FD_SET(ffd, &rs);
        if (select(mfd > ffd ? mfd + 1 : ffd + 1, &rs, NULL, NULL, NULL) < 0) {
            if (errno == EINTR) continue;
            perror("select");
            return 1;
        }
        if (FD_ISSET(mfd, &rs)) {
            ssize_t n = read(mfd, buf, sizeof buf);
            if (n < 0) { perror("read master"); return 1; }
            if (n > 0) log_hex("TX", buf, (size_t)n); /* 桥→设备 */
        }
        if (FD_ISSET(ffd, &rs)) {
            ssize_t n = read(ffd, buf, sizeof buf);
            if (n > 0) {
                log_hex("IN", buf, (size_t)n);
                if (write(mfd, buf, (size_t)n) < 0) perror("write master"); /* 注入→桥读为 RX */
            }
        }
    }
}
