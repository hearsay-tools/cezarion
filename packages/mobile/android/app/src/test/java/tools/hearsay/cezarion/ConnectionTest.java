package tools.hearsay.cezarion;

import org.junit.Test;
import static org.junit.Assert.*;

public class ConnectionTest {
    @Test public void rejectsUnsafeSavedAddresses() {
        for (String value : new String[]{"", "http://localhost", "http://example.com", "javascript:alert(1)", "https://user:pass@example.com", "https://example.com?token=secret", "https://example.com#token", "https://example.com:0", "https://example.com:65536", "https://example.com\\@evil.test", "https://exa mple.com"}) {
            assertThrows(value, IllegalArgumentException.class, () -> new Connection(value, ""));
        }
    }
    @Test public void matchesExactOriginsAndRejectsCredentials() {
        Connection c = new Connection("https://cockpit.example.com/", "https://auth.example.com");
        for (String value : new String[]{"https://cockpit.example.com/api/v1", "https://auth.example.com/?rd=callback", "https://COCKPIT.example.com:443/p/project"}) assertTrue(value, c.allows(value));
        for (String value : new String[]{"http://cockpit.example.com", "https://cockpit.example.com.evil.test/", "https://auth.example.com:8443/", "https://other.example.com", "https://user@cockpit.example.com", "file:///etc/passwd", "javascript:alert(1)"}) assertFalse(value, c.allows(value));
    }
    @Test public void validatesAuthOriginAndTrustChanges() {
        assertThrows(IllegalArgumentException.class, () -> new Connection("https://example.com", "https://auth.example.com/login"));
        Connection c = new Connection(" https://example.com ", "https://auth.example.com:443/");
        assertEquals("https://auth.example.com", c.signInOrigin);
        assertNotEquals(c, new Connection("https://example.com", ""));
        assertFalse(new Connection("https://example.com", "").allows("https://auth.example.com"));
    }
}
