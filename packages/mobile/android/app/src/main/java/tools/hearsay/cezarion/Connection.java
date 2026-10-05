package tools.hearsay.cezarion;

import java.net.URI;
import java.util.Locale;
import java.util.Objects;

/** No native bridge is available to a remote page. Only these origins may navigate in-app. */
public final class Connection {
    public final String endpoint;
    public final String signInOrigin;

    public Connection(String endpoint, String signInOrigin) {
        URI server = parse(endpoint);
        this.endpoint = server.toASCIIString();
        if (signInOrigin.trim().isEmpty()) this.signInOrigin = "";
        else {
            URI auth = parse(signInOrigin);
            if (!auth.getPath().isEmpty() && !auth.getPath().equals("/"))
                throw new IllegalArgumentException("The sign-in origin must have no path, for example https://auth.example.com.");
            this.signInOrigin = origin(auth);
        }
    }

    public static URI parse(String raw) {
        try {
            URI uri = new URI(raw.trim());
            if (origin(uri) == null || uri.getRawQuery() != null || uri.getRawFragment() != null)
                throw new IllegalArgumentException();
            return uri;
        } catch (Exception error) {
            throw new IllegalArgumentException("Enter an HTTPS address without passwords, query parameters, or fragments.");
        }
    }

    public static String origin(URI uri) {
        if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null || uri.getHost().isEmpty()
            || uri.getRawUserInfo() != null || uri.getPort() == 0 || uri.getPort() > 65535 || uri.getPort() < -1)
            return null;
        return "https://" + uri.getHost().toLowerCase(Locale.ROOT)
            + (uri.getPort() == -1 || uri.getPort() == 443 ? "" : ":" + uri.getPort());
    }

    public static String safeOrigin(String raw) {
        try { return origin(new URI(raw)); } catch (Exception ignored) { return null; }
    }

    public boolean allows(String raw) {
        String candidate = safeOrigin(raw);
        return candidate != null && (candidate.equals(safeOrigin(endpoint))
            || (!signInOrigin.isEmpty() && candidate.equals(signInOrigin)));
    }

    @Override public boolean equals(Object other) {
        return other instanceof Connection c && endpoint.equals(c.endpoint) && signInOrigin.equals(c.signInOrigin);
    }
    @Override public int hashCode() { return Objects.hash(endpoint, signInOrigin); }
}
