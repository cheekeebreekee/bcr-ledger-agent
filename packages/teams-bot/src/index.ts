/**
 * Azure Functions v4 entry-point for the Teams bot. The v4 model discovers
 * functions by importing every file that calls `app.http(...)` (or similar)
 * at module load time, so this file simply pulls in our function modules.
 */
import './functions/messages';
