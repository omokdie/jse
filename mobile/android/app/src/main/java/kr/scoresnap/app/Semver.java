package kr.scoresnap.app;

/** Minimal semantic-version comparison ("1.2.10" > "1.2.9"; "1.2.0-beta" < "1.2.0"). */
final class Semver {

    private Semver() {}

    static int compare(String a, String b) {
        Parsed pa = parse(a);
        Parsed pb = parse(b);
        for (int i = 0; i < 3; i++) {
            if (pa.nums[i] != pb.nums[i]) {
                return pa.nums[i] > pb.nums[i] ? 1 : -1;
            }
        }
        if (pa.pre.equals(pb.pre)) return 0;
        if (pa.pre.isEmpty()) return 1;   // release > pre-release
        if (pb.pre.isEmpty()) return -1;
        return pa.pre.compareTo(pb.pre);
    }

    static boolean isValid(String v) {
        if (v == null) return false;
        String s = v.trim();
        if (s.startsWith("v") || s.startsWith("V")) s = s.substring(1);
        return s.matches("\\d+\\.\\d+\\.\\d+([-+][0-9A-Za-z.+-]*)?");
    }

    private static final class Parsed {
        final long[] nums = new long[3];
        String pre = "";
    }

    private static Parsed parse(String v) {
        Parsed p = new Parsed();
        if (v == null) return p;
        String s = v.trim();
        if (s.startsWith("v") || s.startsWith("V")) s = s.substring(1);
        int plus = s.indexOf('+');
        if (plus >= 0) s = s.substring(0, plus);          // build metadata is ignored
        int dash = s.indexOf('-');
        if (dash >= 0) {
            p.pre = s.substring(dash + 1);
            s = s.substring(0, dash);
        }
        String[] parts = s.split("\\.");
        for (int i = 0; i < 3 && i < parts.length; i++) {
            try {
                p.nums[i] = Long.parseLong(parts[i].trim());
            } catch (NumberFormatException e) {
                p.nums[i] = 0;
            }
        }
        return p;
    }
}
