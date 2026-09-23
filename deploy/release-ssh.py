#!/usr/bin/env python3
"""Forced SSH command. No shell, port forwarding, SCP or arbitrary arguments."""
import os
import re
import shlex
import sys
try:
    args = shlex.split(os.environ.get('SSH_ORIGINAL_COMMAND', ''))
    if len(args) == 4 and args[0] == 'start':
        assert re.fullmatch(r'v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)', args[1])
        assert re.fullmatch(r'[0-9a-f]{40}', args[2])
        assert re.fullmatch(r'sha256:[0-9a-f]{64}', args[3])
    elif len(args) == 2 and args[0] == 'status':
        assert re.fullmatch(r'[0-9a-f]{24}', args[1])
    else:
        raise ValueError()
except (ValueError, AssertionError):
    print('Only release start/status are allowed', file=sys.stderr)
    sys.exit(2)
os.execv('/usr/bin/sudo', ['sudo', '-n', '/usr/local/sbin/acornary-release'] + args)
