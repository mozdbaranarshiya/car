package ir.radyabi.app;

import android.Manifest;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;
import android.location.LocationManager;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import org.json.JSONObject;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

final class State {
    private final Context context;
    final SharedPreferences prefs;
    State(Context context) { this.context = context.getApplicationContext(); prefs = this.context.getSharedPreferences("tracker", Context.MODE_PRIVATE); }
    boolean registered() { return prefs.contains("token"); }
    boolean sharing() { return prefs.getBoolean("sharing", false); }
    boolean pendingRevoke() { return prefs.getBoolean("pending_revoke", false); }
    boolean foregroundPermission() {
        return context.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
            context.checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }
    boolean alwaysPermission() {
        return foregroundPermission() && (Build.VERSION.SDK_INT < 29 || context.checkSelfPermission(Manifest.permission.ACCESS_BACKGROUND_LOCATION) == PackageManager.PERMISSION_GRANTED);
    }
    boolean locationEnabled() {
        LocationManager manager = context.getSystemService(LocationManager.class);
        if (Build.VERSION.SDK_INT >= 28) return manager.isLocationEnabled();
        return manager.isProviderEnabled(LocationManager.GPS_PROVIDER) || manager.isProviderEnabled(LocationManager.NETWORK_PROVIDER);
    }
    String server() { return prefs.getString("server", ""); }
    String name() { return prefs.getString("name", ""); }
    String phone() { return prefs.getString("phone", ""); }
    void status(String message) { prefs.edit().putString("status", message).apply(); }
    JSONObject location() {
        try { return new JSONObject(prefs.getString("location", "{}")); } catch (Exception e) { return new JSONObject(); }
    }
    private SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
        if (!store.containsAlias("tracker_token")) {
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder("tracker_token", KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
            generator.generateKey();
        }
        return (SecretKey) store.getKey("tracker_token", null);
    }
    void register(String server, JSONObject result) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, key());
        String secret = Base64.encodeToString(cipher.doFinal(result.getString("token").getBytes(StandardCharsets.UTF_8)), Base64.NO_WRAP);
        prefs.edit().putString("token", secret).putString("token_iv", Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP))
            .putString("server", server).putString("name", result.getString("name")).putString("phone", result.getString("phone"))
            .putBoolean("sharing", true).putBoolean("pending_revoke", false).commit();
    }
    String token() throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, Base64.decode(prefs.getString("token_iv", ""), Base64.NO_WRAP)));
        return new String(cipher.doFinal(Base64.decode(prefs.getString("token", ""), Base64.NO_WRAP)), StandardCharsets.UTF_8);
    }
}
