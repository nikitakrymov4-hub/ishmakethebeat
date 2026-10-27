"""Extract the two user-supplied archives locally, retaining untouched originals.

Accepts an optional Downloads directory. Rejects traversal and archive links;
ZIP CRC validation runs before extraction. No network or external publication.
"""
from pathlib import Path, PurePosixPath
import stat
import subprocess
import sys
import zipfile

root=Path(__file__).resolve().parents[1]/"private-assets"
downloads=Path(sys.argv[1]) if len(sys.argv)>1 else Path.home()/"Downloads"
rar=downloads/"Culture Drum Kit.rar"
zipped=downloads/"wetransfer_1_prodfrustration_personal_tdf_stash_kit_v2_with_presets.zip"


def check_name(name):
    p=PurePosixPath(name.replace("\\","/"))
    if p.is_absolute() or ".." in p.parts:
        raise RuntimeError(f"Unsafe archive member: {name}")


for line in subprocess.check_output(["bsdtar","-tf",str(rar)],text=True).splitlines():
    check_name(line)
for line in subprocess.check_output(["bsdtar","-tvf",str(rar)],text=True).splitlines():
    if line and line[0] not in "-d":
        raise RuntimeError("Only regular files and directories are accepted in RAR")
(root/"culture-kit").mkdir(parents=True,exist_ok=True)
subprocess.run(["bsdtar","-xf",str(rar),"-C",str(root/"culture-kit")],check=True)
with zipfile.ZipFile(zipped) as archive:
    for member in archive.infolist():
        check_name(member.filename)
        if stat.S_ISLNK(member.external_attr>>16):
            raise RuntimeError("Archive symlinks are not accepted")
    bad=archive.testzip()
    if bad:
        raise RuntimeError(f"ZIP CRC failure: {bad}")
    archive.extractall(root/"stash-kit")
print("Both archives extracted; ZIP member CRCs passed. Original archives retained.")
