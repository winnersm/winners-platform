from dataclasses import dataclass, field


@dataclass
class LinkConfig:
    name: str
    url: str
    expected_final: str | None = None
    expected_redirect: bool = True
    expected_text: str | None = None
    max_response_ms: int = 8000
    timeout_ms: int = 15000
    max_redirects: int = 10
    user_agent: str = ""


@dataclass
class CheckResult:
    name: str
    ok: bool
    status_final: int | None = None
    final_url: str | None = None
    redirect_chain: list[str] = field(default_factory=list)
    response_ms: int = 0
    failures: list[str] = field(default_factory=list)   # lista legible de qué falló
    checked_at: str = ""                                  # ISO timestamp
