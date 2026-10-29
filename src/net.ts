// IPv4 as is; IPv6 reduced to its /64 (first four hextets), after expanding "::" and any embedded IPv4.
export function addressGroup(ip: string): string {
  if (!ip.includes(":")) return ip;
  let s = ip.toLowerCase().split("%")[0];
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number);
    s = s.slice(0, v4.index) + ((a << 8) | b).toString(16) + ":" + ((c << 8) | d).toString(16);
  }
  const [head, tail] = s.split("::");
  const h = head ? head.split(":") : [];
  const t = tail !== undefined && tail ? tail.split(":") : [];
  const full = tail !== undefined ? [...h, ...Array(8 - h.length - t.length).fill("0"), ...t] : h;
  return full.slice(0, 4).map((x) => (parseInt(x || "0", 16) || 0).toString(16)).join(":") + "::/64";
}
