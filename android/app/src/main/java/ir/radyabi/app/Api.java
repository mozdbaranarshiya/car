package ir.radyabi.app;

import android.content.Context;
import org.json.JSONObject;
import java.net.URL;
import java.io.InputStream;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import javax.net.ssl.HttpsURLConnection;

final class Api {
    static final ExecutorService IO = Executors.newSingleThreadExecutor();
    static final class Failure extends Exception {
        final int status;
        Failure(int status, String text) { super(text); this.status = status; }
    }
    static String validateServer(String input) throws Exception {
        return ServerAddress.validate(input);
    }
    static JSONObject request(String server, String path, JSONObject data, String token) throws Exception {
        HttpsURLConnection connection = (HttpsURLConnection) new URL(server + path).openConnection();
        connection.setConnectTimeout(12000); connection.setReadTimeout(12000); connection.setInstanceFollowRedirects(false);
        connection.setRequestProperty("Accept", "application/json");
        if (token != null) connection.setRequestProperty("Authorization", "Bearer " + token);
        try {
            if (data != null) {
                connection.setRequestMethod("POST"); connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                byte[] bytes = data.toString().getBytes(StandardCharsets.UTF_8);
                connection.setDoOutput(true); connection.setFixedLengthStreamingMode(bytes.length);
                try (var out = connection.getOutputStream()) { out.write(bytes); }
            }
            int status = connection.getResponseCode();
            InputStream input = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            ByteArrayOutputStream buffer = new ByteArrayOutputStream();
            if (input != null) try (input) {
                byte[] chunk = new byte[4096]; int count;
                while ((count = input.read(chunk)) != -1) { buffer.write(chunk,0,count); if (buffer.size()>65536) throw new Exception("پاسخ سامانه نامعتبر است."); }
            }
            JSONObject result;
            try { result = new JSONObject(buffer.toString(StandardCharsets.UTF_8.name())); }
            catch (Exception e) { throw new Failure(status, "پاسخ سامانه نامعتبر است؛ آدرس سرور را بررسی کنید."); }
            if (status < 200 || status >= 300) throw new Failure(status, result.optString("error", "ارتباط با سامانه برقرار نشد."));
            return result;
        } finally { connection.disconnect(); }
    }
    static JSONObject device(Context context, String path, JSONObject data) throws Exception {
        State state = new State(context); return request(state.server(), path, data, state.token());
    }
    static void flushRevocation(Context context) throws Exception {
        State state = new State(context);
        if (!state.registered() || !state.pendingRevoke() || state.sharing()) return;
        device(context, "/api/device/consent", new JSONObject().put("consent", false));
        state.prefs.edit().putBoolean("pending_revoke", false).apply();
    }
}
