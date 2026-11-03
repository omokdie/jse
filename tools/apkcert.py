import struct, sys, hashlib
data = open(sys.argv[1], 'rb').read()
# End of central directory
eocd = data.rfind(b'PK\x05\x06')
cd_off = struct.unpack('<I', data[eocd+16:eocd+20])[0]
magic = data[cd_off-16:cd_off]
assert magic == b'APK Sig Block 42', 'no APK signing block'
size2 = struct.unpack('<Q', data[cd_off-24:cd_off-16])[0]
start = cd_off - size2 - 8
pairs = data[start+8:cd_off-24]
i = 0
def lp(buf, o):
    n = struct.unpack('<I', buf[o:o+4])[0]; return buf[o+4:o+4+n], o+4+n
while i < len(pairs):
    n = struct.unpack('<Q', pairs[i:i+8])[0]; pid = struct.unpack('<I', pairs[i+8:i+12])[0]; val = pairs[i+12:i+8+n]; i += 8 + n
    name = {0x7109871a: 'v2', 0xf05368c0: 'v3', 0x1b93ad61: 'v3.1'}.get(pid)
    if not name: continue
    signers, _ = lp(val, 0)
    signer, _ = lp(signers, 0)
    signed, _ = lp(signer, 0)
    digests, o = lp(signed, 0)
    certs, o = lp(signed, o)
    cert, _ = lp(certs, 0)
    fp = hashlib.sha256(cert).hexdigest().upper()
    print(name, ':'.join(fp[k:k+2] for k in range(0, 64, 2)))
