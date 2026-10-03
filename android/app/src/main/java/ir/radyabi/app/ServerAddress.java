package ir.radyabi.app;

import java.net.URI;

final class ServerAddress {
    static String validate(String input) throws Exception {
        String value = input.trim();
        while (value.endsWith("/")) value = value.substring(0, value.length() - 1);
        URI uri = new URI(value);
        String path = uri.getRawPath();
        if (!"https".equals(uri.getScheme()) || uri.getHost() == null || uri.getRawUserInfo() != null ||
                uri.getRawQuery() != null || uri.getRawFragment() != null ||
                !(path.isEmpty() || "/functions/v1/tracker".equals(path)))
            throw new Exception("آدرس HTTPS سرویس را وارد کنید؛ مانند https://PROJECT.supabase.co/functions/v1/tracker");
        return value;
    }
}
