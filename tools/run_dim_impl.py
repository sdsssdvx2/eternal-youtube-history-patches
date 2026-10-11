from pathlib import Path

p = Path("tools/implement_watched_dim.py")
s = p.read_text()
s = s.replace('private static boolean isWholeCardPath', 'private static boolean looksLikeWholeVideoCard')
s = s.replace('if (!isWholeCardPath(path)) return false;', 'if (!looksLikeWholeVideoCard(path)) return false;')
code = compile(s, str(p), "exec")
exec(code, {"__name__": "__main__", "__file__": str(p)})
