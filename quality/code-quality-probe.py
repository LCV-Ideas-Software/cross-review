"""Analysis-only Python marker for GitHub code scanning.

This module is deliberately not imported by the cross-review runtime or by any
test. Its only purpose is to keep one analyzable Python file in this
repository: the CodeQL default setup applied by the Enterprise security
configuration analyzes Python, and CodeQL fails a configured language whose
source it cannot find. That failure would redden the required code-scanning
check on every pull request into `main`.
"""

CODE_QUALITY_PROBE = {
    "repository": "LCV-Ideas-Software/cross-review",
    "purpose": "CodeQL default-setup Python language detection",
}
