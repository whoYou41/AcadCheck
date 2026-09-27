package io.ionic.starter;
import org.junit.Test;
import static org.junit.Assert.*;
public class ScorePrintLayoutTest {
    @Test public void bottomFirstPrintMapsBackToHeadingSideOnUprightLongBond() {
        assertEquals(3060,ScorePrintLayout.PAGE_WIDTH);
        assertEquals(4680,ScorePrintLayout.PAGE_HEIGHT);
        int uprightX = 3060 - (ScorePrintLayout.LEFT + 42) - ScorePrintLayout.LABEL_WIDTH;
        int uprightY = 4680 - (ScorePrintLayout.TOP + 42) - ScorePrintLayout.LABEL_HEIGHT;
        assertEquals(2538,uprightX); // 7.05 inches from full-sheet left edge.
        assertEquals(720,uprightY); // 2 inches below the university-header edge.
        assertEquals(0,(ScorePrintLayout.ROTATION_DEGREES + 180) % 360);
        assertTrue(uprightX > 6.9 * 360); // Clear of the right-hand ANSWER SHEET title.
        assertTrue(uprightY + ScorePrintLayout.LABEL_HEIGHT < 2.5 * 360); // Above name fields.
        assertTrue(ScorePrintLayout.LEFT >= 0 && ScorePrintLayout.TOP >= 0);
        assertTrue(ScorePrintLayout.LEFT + ScorePrintLayout.LABEL_WIDTH <= EscP2Encoder.WIDTH);
        assertTrue(ScorePrintLayout.TOP + ScorePrintLayout.LABEL_HEIGHT <= EscP2Encoder.HEIGHT);
    }
}
