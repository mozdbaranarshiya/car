package ir.radyabi.app;

public final class ServerAddressTest {
    public static void main(String[] args) throws Exception {
        assert ServerAddress.validate(" https://example.supabase.co/functions/v1/tracker/ ")
                .equals("https://example.supabase.co/functions/v1/tracker");
        assert ServerAddress.validate("https://tracking.example.com/").equals("https://tracking.example.com");
        String[] invalid = { "http://example.supabase.co/functions/v1/tracker", "https://user:pass@example.com",
                "https://example.com/functions/v1/tracker?token=secret", "https://example.com/#secret",
                "https://owner.github.io/car/", "https://example.com/functions/v1/other",
                "https://example.com/functions/v1/%74racker" };
        for (String value : invalid) {
            boolean rejected = false;
            try { ServerAddress.validate(value); } catch (Exception expected) { rejected = true; }
            assert rejected : "Unsafe or unsupported URL accepted: " + value;
        }
        System.out.println("Android service URL validation passed.");
    }
}
