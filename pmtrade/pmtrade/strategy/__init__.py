"""Strategy implementations, shared by research and paper trading (BLUEPRINT §7).

The same ``Strategy`` implementation runs under both drivers. Two code paths
that are supposed to agree but are written separately will silently diverge.
"""
