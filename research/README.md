# Research utilities

These programs preserve the experiments used to understand the TP6-S. They
are not part of the supported command-line interface, may require additional
macOS frameworks or direct device addresses, and can consume paper.

- `ble_stream.py` compares BLE write strategies.
- `frame_ab.py` varies CUS image-frame structure.
- `stair.py` produces a dropped-frame staircase.
- `spp_print.py` exercises Bluetooth Classic RFCOMM on macOS.
- `token_probe.py` tests the firmware's `0x80` response.
- `make_calibration.py` and `make_typeladder.py` regenerate the included
  physical specimens.

Read [`../INVESTIGATION.md`](../INVESTIGATION.md) before running them. Use the
supported `./tp6` commands for ordinary printing.

Prepare the project environment first, then invoke research programs through
that interpreter (the files are intentionally not installed as commands):

```bash
./setup.sh
~/.venvs/tp6s/bin/python research/ble_stream.py --help
~/.venvs/tp6s/bin/python research/stair.py --help
```

The SPP experiment imports an additional macOS PyObjC framework; run
`./setup.sh --research` before using it. Individual script docstrings describe
device-address and paper requirements.
