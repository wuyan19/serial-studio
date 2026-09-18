/* ss-board-bridge.c —— Serial Studio 开发板串口桥（参考实现）
 *
 * 在任意 Linux 开发板上把本机 UART 接入某个 serial-studio 实例（hub）：
 * 实现"远程设备协议"的设备端子集（见 docs/device-protocol.md），hub 主动连上来，
 * 设备端口即以 `昵称::端口名` 出现在 hub 的 Web UI / 脚本 / MCP 工具里——
 * AI agent 经 MCP 直达开发板串口。
 *
 * 特性：单文件、纯 libc、无第三方依赖；单条 WS 连接（hub 恰好单连接）；
 *       instance_id 持久化（身份跨重启不变是协议硬约定）。
 *
 * 用法：
 *   ./ss-board-bridge --listen 0.0.0.0:18700 \
 *                     --port ttyS1=/dev/ttyS1 --port gps=/dev/ttyUSB0 \
 *                     [--id-file /var/lib/ss-board-bridge.id]
 *
 * 编译（静态，任一架构）：
 *   musl-gcc -O2 -static -o ss-board-bridge ss-board-bridge.c
 *   zig cc -target aarch64-linux-musl  -O2 -static -o ss-board-bridge-arm64  ss-board-bridge.c
 *   zig cc -target arm-linux-musleabihf -O2 -static -o ss-board-bridge-armv7 ss-board-bridge.c
 *
 * 简化边界（生产请按需加固）：忽略 WS 分片细节外的畸形帧容忍、TLS/认证、
 *   set_alias 仅应答不持久化、单客户端（忙时新连接被 503 拒绝）、发送阻塞靠断连兜底。
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h> /* strncasecmp(WS 握手头匹配;部分严格工具链不在 string.h 里) */
#include <stdint.h>
#include <stdarg.h>
#include <errno.h>
#include <unistd.h>
#include <fcntl.h>
#include <signal.h>
#include <time.h>
#include <termios.h>
#include <sys/types.h>
#include <sys/socket.h>
#include <sys/select.h>
#include <netinet/in.h>
#include <arpa/inet.h>

#define BRIDGE_VERSION "ss-board-bridge/1.0"
#define WS_GUID "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
#define MAX_PORTS 16
#define RX_CHUNK 16384

/* ================= 日志 ================= */

static void log_ts(void) {
    char t[32];
    time_t now = time(NULL);
    struct tm tmv;
    localtime_r(&now, &tmv);
    strftime(t, sizeof t, "%H:%M:%S", &tmv);
    fprintf(stderr, "[%s] ", t);
}

static void logf_(const char *fmt, ...) {
    va_list ap;
    log_ts();
    va_start(ap, fmt);
    vfprintf(stderr, fmt, ap);
    va_end(ap);
    fputc('\n', stderr);
}

static void die(const char *msg) {
    logf_("fatal: %s (%s)", msg, strerror(errno));
    exit(1);
}

/* ================= 动态字符串（JSON 构造） ================= */

typedef struct {
    char *p;
    size_t len, cap;
} sbuf;

static void sb_reserve(sbuf *b, size_t need) {
    if (b->len + need + 1 <= b->cap) return;
    size_t ncap = b->cap ? b->cap * 2 : 256;
    while (ncap < b->len + need + 1) ncap *= 2;
    b->p = realloc(b->p, ncap);
    if (!b->p) die("realloc");
    b->cap = ncap;
}

static void sb_put(sbuf *b, const char *s, size_t n) {
    sb_reserve(b, n);
    memcpy(b->p + b->len, s, n);
    b->len += n;
    b->p[b->len] = 0;
}

static void sb_str(sbuf *b, const char *s) { sb_put(b, s, strlen(s)); }

/* JSON 字符串字面量（含转义；\uXXXX 之外的控制在参考实现里直接放行） */
static void sb_jstr(sbuf *b, const char *s) {
    sb_str(b, "\"");
    for (; *s; s++) {
        unsigned char c = (unsigned char)*s;
        switch (c) {
        case '"': sb_str(b, "\\\""); break;
        case '\\': sb_str(b, "\\\\"); break;
        case '\n': sb_str(b, "\\n"); break;
        case '\r': sb_str(b, "\\r"); break;
        case '\t': sb_str(b, "\\t"); break;
        default:
            if (c < 0x20) {
                char esc[8];
                snprintf(esc, sizeof esc, "\\u%04x", c);
                sb_str(b, esc);
            } else {
                sb_put(b, (const char *)&c, 1);
            }
        }
    }
    sb_str(b, "\"");
}

/* 先测长再写入：格式化结果任意长度都不会截断（acquired 应答 >128B，
 * 早期实现用固定栈缓冲被 vsnprintf 截成半截 JSON，hub 端解析失败表现为"远端打开超时"） */
static void sb_fmt(sbuf *b, const char *fmt, ...) {
    va_list ap, ap2;
    va_start(ap, fmt);
    va_copy(ap2, ap);
    int n = vsnprintf(NULL, 0, fmt, ap);
    va_end(ap);
    if (n < 0) {
        va_end(ap2);
        return;
    }
    sb_reserve(b, (size_t)n);
    vsnprintf(b->p + b->len, (size_t)n + 1, fmt, ap2);
    va_end(ap2);
    b->len += (size_t)n;
}

/* ================= SHA-1 + Base64（WS 握手 Accept 计算） ================= */

static void sha1(const uint8_t *msg, size_t len, uint8_t out[20]) {
    uint32_t h[5] = {0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0};
    uint64_t bits = (uint64_t)len * 8;
    size_t total = ((len + 8) / 64 + 1) * 64;
    uint8_t *m = calloc(1, total);
    if (!m) die("calloc");
    memcpy(m, msg, len);
    m[len] = 0x80;
    for (int i = 0; i < 8; i++) m[total - 1 - i] = (uint8_t)(bits >> (8 * i));
    for (size_t off = 0; off < total; off += 64) {
        uint32_t w[80];
        for (int i = 0; i < 16; i++)
            w[i] = ((uint32_t)m[off + 4 * i] << 24) | ((uint32_t)m[off + 4 * i + 1] << 16) |
                   ((uint32_t)m[off + 4 * i + 2] << 8) | (uint32_t)m[off + 4 * i + 3];
        for (int i = 16; i < 80; i++) {
            uint32_t v = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
            w[i] = (v << 1) | (v >> 31);
        }
        uint32_t a = h[0], b = h[1], c = h[2], d = h[3], e = h[4];
        for (int i = 0; i < 80; i++) {
            uint32_t f, k;
            if (i < 20) { f = (b & c) | (~b & d); k = 0x5A827999; }
            else if (i < 40) { f = b ^ c ^ d; k = 0x6ED9EBA1; }
            else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDC; }
            else { f = b ^ c ^ d; k = 0xCA62C1D6; }
            uint32_t t = ((a << 5) | (a >> 27)) + f + e + k + w[i];
            e = d; d = c; c = (b << 30) | (b >> 2); b = a; a = t;
        }
        h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e;
    }
    free(m);
    for (int i = 0; i < 5; i++) {
        out[4 * i] = (uint8_t)(h[i] >> 24);
        out[4 * i + 1] = (uint8_t)(h[i] >> 16);
        out[4 * i + 2] = (uint8_t)(h[i] >> 8);
        out[4 * i + 3] = (uint8_t)h[i];
    }
}

static void b64_encode(const uint8_t *in, size_t n, char out[32]) {
    static const char T[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    size_t o = 0;
    for (size_t i = 0; i < n; i += 3) {
        uint32_t v = (uint32_t)in[i] << 16;
        if (i + 1 < n) v |= (uint32_t)in[i + 1] << 8;
        if (i + 2 < n) v |= in[i + 2];
        out[o++] = T[(v >> 18) & 63];
        out[o++] = T[(v >> 12) & 63];
        out[o++] = (i + 1 < n) ? T[(v >> 6) & 63] : '=';
        out[o++] = (i + 2 < n) ? T[v & 63] : '=';
    }
    out[o] = 0;
}

/* ================= WebSocket 帧层 ================= */

typedef struct {
    int fd;
    uint8_t buf[16384];
    size_t len, pos;
} ws_rd;

static ssize_t rd_fill(ws_rd *r) {
    if (r->pos > 0) { memmove(r->buf, r->buf + r->pos, r->len - r->pos); r->len -= r->pos; r->pos = 0; }
    ssize_t n = recv(r->fd, r->buf + r->len, sizeof r->buf - r->len, 0);
    if (n > 0) r->len += (size_t)n;
    return n;
}

static int rd_exact(ws_rd *r, uint8_t *out, size_t n) {
    while (r->len - r->pos < n) {
        if (rd_fill(r) <= 0) return -1;
    }
    memcpy(out, r->buf + r->pos, n);
    r->pos += n;
    return 0;
}

/* 读一帧（含分片重组）。返回 opcode（0x8 close / 0x9 ping / 0xA pong / 0x1 text / 0x2 bin），
 * payload 出参调用方 free；失败/断连返回 -1。 */
static int ws_read_frame(ws_rd *r, uint8_t **payload, size_t *plen) {
    static uint8_t *acc = NULL;
    static size_t acc_len = 0, acc_cap = 0;
    uint8_t hdr[2], ext[8], mask[4];
    for (;;) {
        if (rd_exact(r, hdr, 2) < 0) return -1;
        int fin = hdr[0] & 0x80, op = hdr[0] & 0x0F;
        int masked = hdr[1] & 0x80;
        uint64_t len = hdr[1] & 0x7F;
        if (len == 126) {
            if (rd_exact(r, ext, 2) < 0) return -1;
            len = ((uint64_t)ext[0] << 8) | ext[1];
        } else if (len == 127) {
            if (rd_exact(r, ext, 8) < 0) return -1;
            len = 0;
            for (int i = 0; i < 8; i++) len = (len << 8) | ext[i];
        }
        if (len > 4u * 1024 * 1024) { logf_("WS frame too large: %llu", (unsigned long long)len); return -1; }
        if (masked && rd_exact(r, mask, 4) < 0) return -1;
        uint8_t *p = malloc(len ? (size_t)len : 1);
        if (!p) die("malloc");
        if (len && rd_exact(r, p, (size_t)len) < 0) { free(p); return -1; }
        if (masked)
            for (uint64_t i = 0; i < len; i++) p[i] ^= mask[i & 3];

        if (op == 0x8 || op == 0x9 || op == 0xA) { /* close/ping/pong：独立小帧直接透传 */
            *payload = p;
            *plen = (size_t)len;
            return op;
        }
        if (op == 0x1 || op == 0x2 || op == 0x0) { /* text/binary/continuation */
            if (op != 0x0) { acc_len = 0; } /* 新消息起点（参考实现不严格处理乱序） */
            if (acc_len + len > acc_cap) {
                acc_cap = (acc_len + len) * 2 + 64;
                acc = realloc(acc, acc_cap);
                if (!acc) die("realloc");
            }
            memcpy(acc + acc_len, p, (size_t)len);
            acc_len += (size_t)len;
            free(p);
            if (fin) {
                uint8_t *out = malloc(acc_len ? acc_len : 1);
                if (!out) die("malloc");
                memcpy(out, acc, acc_len);
                *payload = out;
                *plen = acc_len;
                acc_len = 0;
                return op; /* 首片 opcode（重组后即消息类型） */
            }
            continue;
        }
        free(p); /* 未知 opcode 丢弃 */
    }
}

static int send_all(int fd, const void *data, size_t n) {
    const uint8_t *p = data;
    while (n > 0) {
        ssize_t w = send(fd, p, n, MSG_NOSIGNAL);
        if (w < 0) {
            if (errno == EINTR) continue;
            return -1;
        }
        p += w;
        n -= (size_t)w;
    }
    return 0;
}

/* 服务器→客户端帧不掩码 */
static int ws_send(int fd, int opcode, const void *payload, size_t n) {
    uint8_t hdr[10];
    size_t hl = 0;
    hdr[hl++] = (uint8_t)(0x80 | opcode);
    if (n < 126) {
        hdr[hl++] = (uint8_t)n;
    } else if (n < 65536) {
        hdr[hl++] = 126;
        hdr[hl++] = (uint8_t)(n >> 8);
        hdr[hl++] = (uint8_t)n;
    } else {
        hdr[hl++] = 127;
        for (int i = 7; i >= 0; i--) hdr[hl++] = (uint8_t)(n >> (8 * i));
    }
    if (send_all(fd, hdr, hl) < 0) return -1;
    return send_all(fd, payload, n);
}

static int ws_send_text(int fd, const char *json) { return ws_send(fd, 0x1, json, strlen(json)); }

/* 二进制数据帧：[端口名长度 u8][端口名][数据]（协议 §5） */
static int ws_send_data(int fd, const char *port, const uint8_t *data, size_t n) {
    size_t pn = strlen(port);
    if (pn > 255) return -1;
    uint8_t *frame = malloc(1 + pn + n);
    if (!frame) die("malloc");
    frame[0] = (uint8_t)pn;
    memcpy(frame + 1, port, pn);
    memcpy(frame + 1 + pn, data, n);
    int rc = ws_send(fd, 0x2, frame, 1 + pn + n);
    free(frame);
    return rc;
}

/* HTTP Upgrade 握手：读到空行，取 Sec-WebSocket-Key，回 101 */
static int ws_upgrade(int fd) {
    char req[8192];
    size_t got = 0;
    for (;;) {
        if (got >= sizeof req - 1) return -1;
        ssize_t n = recv(fd, req + got, sizeof req - 1 - got, 0);
        if (n <= 0) return -1;
        got += (size_t)n;
        req[got] = 0;
        if (strstr(req, "\r\n\r\n")) break;
    }
    char key[128] = "";
    char *line = req, *nl;
    while ((nl = strstr(line, "\r\n")) && nl != line) {
        *nl = 0;
        if (strncasecmp(line, "Sec-WebSocket-Key:", 18) == 0) {
            const char *v = line + 18;
            while (*v == ' ') v++;
            snprintf(key, sizeof key, "%s", v);
        }
        line = nl + 2;
    }
    if (!key[0]) return -1;
    char cat[256];
    snprintf(cat, sizeof cat, "%s%s", key, WS_GUID);
    uint8_t dig[20];
    char acc[32];
    sha1((const uint8_t *)cat, strlen(cat), dig);
    b64_encode(dig, 20, acc);
    char resp[256];
    snprintf(resp, sizeof resp,
             "HTTP/1.1 101 Switching Protocols\r\n"
             "Upgrade: websocket\r\nConnection: Upgrade\r\n"
             "Sec-WebSocket-Accept: %s\r\n\r\n",
             acc);
    return send_all(fd, resp, strlen(resp));
}

/* ================= JSON 容错提取（消息形状固定，够用即可） ================= */

/* 找 "key": 定位到值起点。config 等嵌套对象先取子串再查。 */
static const char *find_value(const char *json, const char *key) {
    char pat[64];
    snprintf(pat, sizeof pat, "\"%s\":", key);
    const char *p = strstr(json, pat);
    if (!p) return NULL;
    p += strlen(pat);
    while (*p == ' ' || *p == '\t') p++;
    return p;
}

/* 提取字符串值并做 JSON 反转义（写串口的数据必须先还原 \n/\uXXXX 等） */
static int json_str(const char *json, const char *key, char *out, size_t outn) {
    const char *p = find_value(json, key);
    if (!p || *p != '"') return -1;
    p++;
    size_t o = 0;
    while (*p && *p != '"') {
        unsigned char c = (unsigned char)*p;
        if (c == '\\') {
            p++;
            switch (*p) {
            case 'n': c = '\n'; break;
            case 'r': c = '\r'; break;
            case 't': c = '\t'; break;
            case 'b': c = '\b'; break;
            case 'f': c = '\f'; break;
            case 'u': { /* BMP；代理对在串口场景极罕见，按替换符处理 */
                unsigned cp = 0;
                for (int i = 1; i <= 4; i++) {
                    char h = p[i];
                    cp <<= 4;
                    if (h >= '0' && h <= '9') cp |= (unsigned)(h - '0');
                    else if (h >= 'a' && h <= 'f') cp |= (unsigned)(h - 'a' + 10);
                    else if (h >= 'A' && h <= 'F') cp |= (unsigned)(h - 'A' + 10);
                    else cp = 0xFFFD;
                }
                p += 4;
                if (o + 4 >= outn) { out[o++] = '?'; break; }
                if (cp < 0x80) out[o++] = (char)cp;
                else if (cp < 0x800) { out[o++] = (char)(0xC0 | (cp >> 6)); out[o++] = (char)(0x80 | (cp & 63)); }
                else { out[o++] = (char)(0xE0 | (cp >> 12)); out[o++] = (char)(0x80 | ((cp >> 6) & 63)); out[o++] = (char)(0x80 | (cp & 63)); }
                p++;
                continue;
            }
            default: c = (unsigned char)*p; break; /* \" \\ \/ 等 */
            }
            p++;
        } else {
            p++;
        }
        if (o + 1 >= outn) break;
        out[o++] = (char)c;
    }
    out[o] = 0;
    return 0;
}

static int json_u64(const char *json, const char *key, uint64_t *out) {
    const char *p = find_value(json, key);
    if (!p || (*p < '0' || *p > '9')) return -1;
    *out = 0;
    while (*p >= '0' && *p <= '9') *out = *out * 10 + (uint64_t)(*p++ - '0');
    return 0;
}

/* 取嵌套对象子串（花括号配对，忽略字符串内的括号——config 值均为标量，够用） */
static int json_obj(const char *json, const char *key, char *out, size_t outn) {
    const char *p = find_value(json, key);
    if (!p || *p != '{') return -1;
    const char *s = p;
    int depth = 0;
    while (*p) {
        if (*p == '{') depth++;
        else if (*p == '}') { depth--; if (!depth) break; }
        p++;
    }
    size_t n = (size_t)(p - s + 1);
    if (n >= outn) n = outn - 1;
    memcpy(out, s, n);
    out[n] = 0;
    return 0;
}

/* ================= 串口 ================= */

typedef struct {
    char name[64];
    char path[160];
    int fd; /* -1 = 未打开 */
    struct { uint32_t baud; uint8_t bits; char parity, stop, flow; } cfg;
} port_t;

static port_t ports[MAX_PORTS];
static int nports;

static speed_t baud_const(uint32_t b) {
    switch (b) {
    case 1200: return B1200;     case 2400: return B2400;     case 4800: return B4800;
    case 9600: return B9600;     case 19200: return B19200;   case 38400: return B38400;
    case 57600: return B57600;   case 115200: return B115200; case 230400: return B230400;
    case 460800: return B460800; case 921600: return B921600;
    case 1000000: return B1000000; case 1152000: return B1152000; case 1500000: return B1500000;
    case 2000000: return B2000000; case 2500000: return B2500000; case 3000000: return B3000000;
    case 3500000: return B3500000; case 4000000: return B4000000;
    default: return 0;
    }
}

static int uart_open(port_t *pt, char *err, size_t errn) {
    if (pt->fd >= 0) return 0; /* 已开：幂等（附加语义由 hub 侧处理 holders） */
    speed_t sp = baud_const(pt->cfg.baud);
    if (!sp) { snprintf(err, errn, "open %s: unsupported baud rate %u", pt->name, pt->cfg.baud); return -1; }
    int fd = open(pt->path, O_RDWR | O_NOCTTY);
    if (fd < 0) { snprintf(err, errn, "open %s(%s): %s", pt->name, pt->path, strerror(errno)); return -1; }
    struct termios tio;
    if (tcgetattr(fd, &tio) != 0) { snprintf(err, errn, "open %s: tcgetattr: %s", pt->name, strerror(errno)); close(fd); return -1; }
    cfmakeraw(&tio);
    cfsetispeed(&tio, sp);
    cfsetospeed(&tio, sp);
    tio.c_cflag &= ~(tcflag_t)CSIZE;
    switch (pt->cfg.bits) {
    case 5: tio.c_cflag |= CS5; break;
    case 6: tio.c_cflag |= CS6; break;
    case 7: tio.c_cflag |= CS7; break;
    default: tio.c_cflag |= CS8; break;
    }
    if (pt->cfg.stop == 2) tio.c_cflag |= CSTOPB; else tio.c_cflag &= ~(tcflag_t)CSTOPB;
    if (pt->cfg.parity == 'o') tio.c_cflag |= PARENB | PARODD;
    else if (pt->cfg.parity == 'e') tio.c_cflag |= PARENB;
    else tio.c_cflag &= ~(tcflag_t)PARENB;
    if (pt->cfg.flow == 'h') tio.c_cflag |= CRTSCTS;
    else tio.c_cflag &= ~(tcflag_t)CRTSCTS;
    if (pt->cfg.flow == 's') tio.c_iflag |= IXON | IXOFF | IXANY;
    else tio.c_iflag &= ~(tcflag_t)(IXON | IXOFF | IXANY);
    tio.c_cc[VMIN] = 1;
    tio.c_cc[VTIME] = 0;
    if (tcsetattr(fd, TCSANOW, &tio) != 0) { snprintf(err, errn, "open %s: tcsetattr: %s", pt->name, strerror(errno)); close(fd); return -1; }
    pt->fd = fd;
    return 0;
}

static void uart_close(port_t *pt) {
    if (pt->fd >= 0) {
        close(pt->fd);
        pt->fd = -1;
    }
}

static int hex_nibble(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

/* ================= instance_id：永久身份（协议硬约定：跨重启不变） ================= */

static char instance_id[64];

static void load_instance_id(const char *path) {
    FILE *f = fopen(path, "r");
    if (f) {
        if (fgets(instance_id, sizeof instance_id, f)) {
            instance_id[strcspn(instance_id, " \r\n")] = 0;
            if (instance_id[0]) { fclose(f); return; }
        }
        fclose(f);
    }
    /* 首启生成：/dev/urandom 16 字节 → uuid v4 形态 */
    uint8_t r[16];
    int fd = open("/dev/urandom", O_RDONLY);
    if (fd < 0 || read(fd, r, sizeof r) != (ssize_t)sizeof r) die("read /dev/urandom");
    close(fd);
    r[6] = (uint8_t)((r[6] & 0x0F) | 0x40);
    r[8] = (uint8_t)((r[8] & 0x3F) | 0x80);
    snprintf(instance_id, sizeof instance_id,
             "%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",
             r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7],
             r[8], r[9], r[10], r[11], r[12], r[13], r[14], r[15]);
    f = fopen(path, "w");
    if (!f || fprintf(f, "%s\n", instance_id) < 0 || fclose(f) != 0)
        die("cannot persist instance_id (use --id-file to point at a writable path)");
    logf_("generated device identity %s -> %s", instance_id, path);
}

/* ================= 协议消息处理 ================= */

static void reply_version(int fd) {
    sbuf b = {0};
    sb_str(&b, "{\"type\":\"version\",\"version\":");
    sb_jstr(&b, BRIDGE_VERSION);
    sb_str(&b, ",\"enable_scripting\":true,\"instance_id\":");
    sb_jstr(&b, instance_id);
    sb_str(&b, "}");
    ws_send_text(fd, b.p);
    free(b.p);
}

static void send_ports_snapshot(int fd) {
    sbuf b = {0};
    sb_str(&b, "{\"type\":\"ports\",\"ports\":[");
    for (int i = 0; i < nports; i++) {
        if (i) sb_str(&b, ",");
        sb_str(&b, "{\"name\":");
        sb_jstr(&b, ports[i].name);
        sb_fmt(&b, ",\"opened\":%s,\"holders\":%u,\"disconnected\":false}",
               ports[i].fd >= 0 ? "true" : "false", ports[i].fd >= 0 ? 1u : 0u);
    }
    sb_str(&b, "]}");
    ws_send_text(fd, b.p);
    free(b.p);
}

/* 回一条带 port/req 的 ok / error */
static void reply_status(int fd, int ok, const char *msg, const char *port, int has_req, uint64_t req) {
    sbuf b = {0};
    sb_str(&b, ok ? "{\"type\":\"ok\",\"message\":" : "{\"type\":\"error\",\"message\":");
    sb_jstr(&b, msg);
    if (port) {
        sb_str(&b, ",\"port\":");
        sb_jstr(&b, port);
    }
    if (has_req) sb_fmt(&b, ",\"req\":%llu", (unsigned long long)req);
    sb_str(&b, "}");
    ws_send_text(fd, b.p);
    free(b.p);
}

static void reply_acquired(int fd, port_t *pt, int first_open, int has_req, uint64_t req) {
    sbuf b = {0};
    sb_str(&b, "{\"type\":\"acquired\",\"port\":");
    sb_jstr(&b, pt->name);
    sb_fmt(&b, ",\"opened\":%s,\"config\":{\"baud_rate\":%u,\"data_bits\":\"%s\","
               "\"stop_bits\":\"%s\",\"parity\":\"%s\",\"flow_control\":\"%s\","
               "\"line_ending\":\"lf\",\"timeout_ms\":100},\"holders\":1,\"resolved\":",
           first_open ? "true" : "false", pt->cfg.baud,
           (const char *[]){"five", "six", "seven", "eight"}[pt->cfg.bits < 5 || pt->cfg.bits > 8 ? 3 : pt->cfg.bits - 5],
           pt->cfg.stop == 2 ? "two" : "one",
           pt->cfg.parity == 'o' ? "odd" : pt->cfg.parity == 'e' ? "even" : "none",
           pt->cfg.flow == 'h' ? "hardware" : pt->cfg.flow == 's' ? "software" : "none");
    sb_jstr(&b, pt->name); /* resolved=端口真名：hub 据此登记 IO，缺失会 RX 断流 */
    if (has_req) sb_fmt(&b, ",\"req\":%llu", (unsigned long long)req);
    sb_str(&b, "}");
    ws_send_text(fd, b.p);
    free(b.p);
}

static port_t *find_port(const char *name) {
    for (int i = 0; i < nports; i++)
        if (strcmp(ports[i].name, name) == 0) return &ports[i];
    return NULL;
}

static void handle_action(int fd, const char *msg) {
    char action[32] = "", port[128] = "";
    uint64_t req = 0;
    int has_req = json_u64(msg, "req", &req) == 0;
    json_str(msg, "action", action, sizeof action);
    json_str(msg, "port", port, sizeof port);

    if (strcmp(action, "version") == 0) {
        reply_version(fd);
    } else if (strcmp(action, "list") == 0) {
        send_ports_snapshot(fd);
    } else if (strcmp(action, "open") == 0) {
        port_t *pt = find_port(port);
        if (!pt) {
            char m[192];
            snprintf(m, sizeof m, "open %s: no such port", port);
            reply_status(fd, 0, m, port, has_req, req);
            return;
        }
        char cfg[512];
        if (json_obj(msg, "config", cfg, sizeof cfg) == 0) {
            uint64_t v;
            char s[32];
            if (json_u64(cfg, "baud_rate", &v) == 0) pt->cfg.baud = (uint32_t)v;
            if (json_str(cfg, "data_bits", s, sizeof s) == 0)
                pt->cfg.bits = (uint8_t)(s[0] == 'f' ? 5 : s[0] == 's' ? (s[1] == 'i' ? 6 : 7) : 8);
            if (json_str(cfg, "stop_bits", s, sizeof s) == 0) pt->cfg.stop = (uint8_t)(s[0] == 't' ? 2 : 1);
            if (json_str(cfg, "parity", s, sizeof s) == 0) pt->cfg.parity = s[0] == 'o' || s[0] == 'e' ? s[0] : 'n';
            if (json_str(cfg, "flow_control", s, sizeof s) == 0)
                pt->cfg.flow = s[0] == 'h' || s[0] == 's' ? s[0] : 'n';
            /* line_ending / timeout_ms 是 hub 侧行为语义，忽略 */
        }
        char err[256];
        int first = pt->fd < 0;
        if (uart_open(pt, err, sizeof err) != 0) {
            reply_status(fd, 0, err, port, has_req, req);
            return;
        }
        reply_acquired(fd, pt, first, has_req, req);
        logf_("open %s: baud=%u bits=%u parity=%c stop=%u flow=%c",
              pt->name, pt->cfg.baud, pt->cfg.bits, pt->cfg.parity, pt->cfg.stop, pt->cfg.flow);
    } else if (strcmp(action, "write") == 0) {
        port_t *pt = find_port(port);
        if (!pt || pt->fd < 0) {
            char m[192];
            snprintf(m, sizeof m, "write %s: port not open", port);
            reply_status(fd, 0, m, port, has_req, req);
            return;
        }
        char data[16384], enc[16] = "text";
        if (json_str(msg, "data", data, sizeof data) != 0) {
            reply_status(fd, 0, "write: missing data", port, has_req, req);
            return;
        }
        json_str(msg, "encoding", enc, sizeof enc);
        uint8_t *bytes;
        size_t n;
        if (strcmp(enc, "hex") == 0) {
            size_t hn = strlen(data);
            if (hn % 2) { reply_status(fd, 0, "write: odd-length hex", port, has_req, req); return; }
            n = hn / 2;
            bytes = malloc(n ? n : 1);
            if (!bytes) die("malloc");
            for (size_t i = 0; i < n; i++) {
                int hi = hex_nibble(data[2 * i]), lo = hex_nibble(data[2 * i + 1]);
                if (hi < 0 || lo < 0) { free(bytes); reply_status(fd, 0, "write: invalid hex", port, has_req, req); return; }
                bytes[i] = (uint8_t)((hi << 4) | lo);
            }
        } else {
            n = strlen(data);
            bytes = (uint8_t *)data;
        }
        size_t off = 0;
        while (off < n) {
            ssize_t w = write(pt->fd, bytes + off, n - off);
            if (w < 0) {
                if (errno == EINTR) continue;
                char m[192];
                snprintf(m, sizeof m, "write %s: %s", port, strerror(errno));
                reply_status(fd, 0, m, port, has_req, req);
                free(bytes);
                /* 写失败的口多半已异常：主动关掉，让 hub 侧显断开 */
                uart_close(pt);
                return;
            }
            off += (size_t)w;
        }
        if ((void *)bytes != (void *)data) free(bytes);
        reply_status(fd, 1, "", port, has_req, req);
    } else if (strcmp(action, "close") == 0) {
        port_t *pt = find_port(port);
        if (pt) uart_close(pt);
        reply_status(fd, 1, "", port, has_req, req); /* 未开也回 ok（幂等） */
    } else if (strcmp(action, "set_alias") == 0) {
        reply_status(fd, 1, "", port, has_req, req); /* 参考实现不持久化别名 */
    } else {
        logf_("ignore unknown action: %s", action[0] ? action : "(empty)");
    }
}

/* ================= 会话主循环 ================= */

static int listen_fd = -1;

static void serve_session(int cfd) {
    if (ws_upgrade(cfd) != 0) {
        logf_("WS handshake failed, closing connection");
        close(cfd);
        return;
    }
    logf_("hub connected");
    /* 建连即推快照（与 serial-studio 服务端行为对齐；hub 也会主动 list） */
    send_ports_snapshot(cfd);
    {
        const char *dev = "{\"type\":\"devices\",\"devices\":[]}";
        ws_send_text(cfd, dev);
    }

    ws_rd rd = {.fd = cfd};
    uint8_t rx[RX_CHUNK];
    for (;;) {
        fd_set rs;
        FD_ZERO(&rs);
        FD_SET(cfd, &rs);
        FD_SET(listen_fd, &rs);
        int maxfd = cfd > listen_fd ? cfd : listen_fd;
        for (int i = 0; i < nports; i++)
            if (ports[i].fd >= 0) {
                FD_SET(ports[i].fd, &rs);
                if (ports[i].fd > maxfd) maxfd = ports[i].fd;
            }
        int rc = select(maxfd + 1, &rs, NULL, NULL, NULL);
        if (rc < 0) {
            if (errno == EINTR) continue;
            break;
        }

        /* 忙时拒绝第二个连接（hub 单连接；多 hub 需自行扩展） */
        if (FD_ISSET(listen_fd, &rs)) {
            int extra = accept(listen_fd, NULL, NULL);
            if (extra >= 0) {
                const char *busy =
                    "HTTP/1.1 503 Busy\r\nConnection: close\r\nContent-Length: 0\r\n\r\n";
                send_all(extra, busy, strlen(busy));
                close(extra);
                logf_("rejecting extra connection (single-client)");
            }
        }

        /* hub → 设备：控制消息 */
        if (FD_ISSET(cfd, &rs)) {
            uint8_t *pl;
            size_t plen;
            int op = ws_read_frame(&rd, &pl, &plen);
            if (op < 0) {
                logf_("hub disconnected");
                break;
            }
            if (op == 0x8) { /* Close：回 Close 后结束 */
                ws_send(cfd, 0x8, pl, plen < 125 ? plen : 125);
                free(pl);
                break;
            }
            if (op == 0x9) { /* Ping → Pong */
                ws_send(cfd, 0xA, pl, plen);
                free(pl);
                continue;
            }
            if (op == 0x1) {
                handle_action(cfd, (const char *)pl);
            }
            free(pl);
        }

        /* 串口 RX → Binary 数据帧 */
        for (int i = 0; i < nports; i++) {
            if (ports[i].fd < 0 || !FD_ISSET(ports[i].fd, &rs)) continue;
            ssize_t n = read(ports[i].fd, rx, sizeof rx);
            if (n <= 0) continue; /* select 可读但读空（奇偶错误等）：忽略 */
            if (ws_send_data(cfd, ports[i].name, rx, (size_t)n) != 0) {
                logf_("data-frame send failed, dropping session (hub will reconnect)");
                goto out;
            }
        }
    }
out:
    for (int i = 0; i < nports; i++) uart_close(&ports[i]);
    close(cfd);
    logf_("session ended, waiting for hub to reconnect");
}

/* ================= 入口 ================= */

static void usage(const char *argv0) {
    fprintf(stderr,
            "Usage: %s [OPTIONS]\n"
            "Expose local serial ports to a Serial Studio hub over WebSocket.\n\n"
            "Options:\n"
            "  --listen IP:PORT   listen address (default 0.0.0.0:18700)\n"
            "  --port NAME=PATH   serial port to expose; repeatable\n"
            "  --id-file PATH     persistent identity file (default /var/lib/ss-board-bridge.id)\n"
            "  -h, --help         show this help\n\n"
            "Example:\n"
            "  %s --listen 0.0.0.0:18700 --port ttyS1=/dev/ttyS1 --port gps=/dev/ttyUSB0\n",
            argv0, argv0);
}

int main(int argc, char **argv) {
    const char *listen_spec = "0.0.0.0:18700";
    const char *id_file = "/var/lib/ss-board-bridge.id";

    signal(SIGPIPE, SIG_IGN);
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--listen") == 0 && i + 1 < argc) listen_spec = argv[++i];
        else if (strcmp(argv[i], "--port") == 0 && i + 1 < argc) {
            char *eq = strchr(argv[++i], '=');
            if (!eq || nports >= MAX_PORTS) { usage(argv[0]); return 1; }
            *eq = 0;
            port_t *pt = &ports[nports++];
            memset(pt, 0, sizeof *pt);
            snprintf(pt->name, sizeof pt->name, "%s", argv[i]);
            snprintf(pt->path, sizeof pt->path, "%s", eq + 1);
            pt->fd = -1;
            pt->cfg.baud = 115200;
            pt->cfg.bits = 8;
            pt->cfg.parity = 'n';
            pt->cfg.stop = 1;
            pt->cfg.flow = 'n';
        } else if (strcmp(argv[i], "--id-file") == 0 && i + 1 < argc) id_file = argv[++i];
        else if (strcmp(argv[i], "--help") == 0 || strcmp(argv[i], "-h") == 0) { usage(argv[0]); return 0; }
        else { usage(argv[0]); return 1; }
    }
    if (nports == 0) { usage(argv[0]); return 1; }

    load_instance_id(id_file);

    char ip[64] = "0.0.0.0";
    int port = 18700;
    char lip[80];
    snprintf(lip, sizeof lip, "%s", listen_spec);
    char *colon = strrchr(lip, ':');
    if (colon) {
        *colon = 0;
        if (lip[0]) snprintf(ip, sizeof ip, "%s", lip);
        port = atoi(colon + 1);
    }

    listen_fd = socket(AF_INET, SOCK_STREAM, 0);
    if (listen_fd < 0) die("socket");
    int one = 1;
    setsockopt(listen_fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
    struct sockaddr_in addr;
    memset(&addr, 0, sizeof addr);
    addr.sin_family = AF_INET;
    addr.sin_port = htons((uint16_t)port);
    addr.sin_addr.s_addr = inet_addr(ip);
    if (bind(listen_fd, (struct sockaddr *)&addr, sizeof addr) != 0) die("bind");
    if (listen(listen_fd, 2) != 0) die("listen");
    logf_("ready: %s:%d | identity %s | %d port(s):", ip, port, instance_id, nports);
    for (int i = 0; i < nports; i++) logf_("  %s = %s", ports[i].name, ports[i].path);

    for (;;) {
        int cfd = accept(listen_fd, NULL, NULL);
        if (cfd < 0) {
            if (errno == EINTR) continue;
            die("accept");
        }
        serve_session(cfd);
    }
}
