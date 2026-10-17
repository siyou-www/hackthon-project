"""Generate VAPID credentials into a NEW private file; never print key values."""
import base64
import os
import sys
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat


def encode(value):
    return base64.urlsafe_b64encode(value).decode().rstrip('=')


def main():
    if len(sys.argv) != 2:
        raise SystemExit('Usage: python scripts/generate_vapid.py /secure/path/daycast-vapid.env')
    key = ec.generate_private_key(ec.SECP256R1())
    private = encode(key.private_numbers().private_value.to_bytes(32, 'big'))
    public = encode(key.public_key().public_bytes(Encoding.X962, PublicFormat.UncompressedPoint))
    descriptor = os.open(sys.argv[1], os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'w') as file:
        file.write(f'VAPID_PRIVATE_KEY={private}\nVAPID_PUBLIC_KEY={public}\n')
    print('Created private key file. Transfer values securely to Render; do not commit or share it.')


if __name__ == '__main__':
    main()
