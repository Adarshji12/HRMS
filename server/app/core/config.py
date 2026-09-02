import os
from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

def _server_root() -> Path:
    """Where alembic.ini and the default storage directory live.

    Derived from __file__ normally, which is right for a checkout and for the
    Docker image. A compiled build moves the modules into a dist directory, so
    the walk upwards lands somewhere else entirely — and the failure is quiet:
    alembic.ini is simply not found and the schema check reports "nothing".
    SERVER_ROOT lets the deployment state it outright rather than hope.
    """
    override = os.environ.get("SERVER_ROOT")
    if override:
        return Path(override)
    return Path(__file__).resolve().parents[2]


SERVER_ROOT = _server_root()


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=SERVER_ROOT / ".env", env_file_encoding="utf-8", extra="ignore"
    )

    app_name: str = "MyDeskTime"

    #: "development" | "staging" | "production". Several guards below are
    #: deliberately fatal in production and merely noisy elsewhere: a local
    #: checkout must stay runnable with no configuration at all, while a real
    #: deployment must refuse to start rather than serve on a default secret.
    environment: str = "development"

    # Unset -> SQLite dev database next to the server package. Production uses
    # postgresql+psycopg://...
    database_url: str = f"sqlite:///{(SERVER_ROOT / 'hrdesktimesol.db').as_posix()}"

    secret_key: str = "dev-only-insecure-key-change-me"
    #: bcrypt cost factor. 12 is the production value and the default.
    #:
    #: Exists to be lowered *by the test suite only* — hashing is deliberately
    #: slow, and a suite that creates several hundred accounts spends minutes on
    #: it for no coverage. Lowering it anywhere real would make every stored
    #: password cheaper to crack, so `main.py` refuses to start on a reduced
    #: factor in production rather than trusting a comment to be read.
    bcrypt_rounds: int = 12
    algorithm: str = "HS256"
    access_token_expire_minutes: int = 720

    # --- multi-tenancy -------------------------------------------------------
    # Tenants live at <slug>.<base_domain>. In development that is
    # "<slug>.localhost", which browsers resolve to 127.0.0.1 without any hosts
    # file entry.
    base_domain: str = "localhost"
    # Where signup and other tenant-less pages live. Must not collide with a slug.
    marketing_host: str = "app"
    # Scheme + host used when building links in emails.
    public_scheme: str = "http"

    #: Default Jitsi deployment for video meetings, when a company has not named
    #: its own in ``organizations.meeting_domain``.
    #:
    #: meet.jit.si is the public instance: free, no account, and **the media
    #: goes through servers this project does not run**. That is fine for a
    #: trial and wrong for anybody with a confidentiality obligation, which is
    #: why the per-tenant override exists and why this is a setting rather than
    #: a constant. Point it at a self-hosted Jitsi and nothing else changes.
    meeting_domain: str = "meet.jit.si"
    public_port: str = "5173"

    cors_origins: str = ""
    # Subdomains cannot be enumerated up front, so CORS is matched by suffix.
    cors_allow_subdomains: bool = True

    # --- storage -------------------------------------------------------------
    #: Run the periodic jobs on a thread inside the API process.
    #:
    #: Off by default: the separate `jobs` container is the right answer, and
    #: this is only safe under a SINGLE uvicorn worker (see
    #: `scheduler.start_in_process`). It exists for hosts with no background
    #: worker and no cron — Render's free tier — where the alternative is
    #: retention and alerts never running at all.
    run_jobs_in_process: bool = False

    storage_backend: str = "local"  # local | s3
    storage_dir: Path = SERVER_ROOT / "storage"
    s3_bucket: str = ""
    s3_region: str = "us-east-1"
    s3_endpoint_url: str = ""  # set for MinIO / R2 / Wasabi
    s3_access_key_id: str = ""
    s3_secret_access_key: str = ""
    s3_presign_seconds: int = 300

    max_screenshot_bytes: int = 5 * 1024 * 1024

    # --- agent downloads -----------------------------------------------------
    #: Where the packaged agent bundles are kept, for the console's download.
    #:
    #: Deliberately outside ``storage_dir``: screenshots are tenant evidence
    #: under a retention policy, and a release artifact is neither. Keeping them
    #: apart also means a new agent build is a file copy rather than a new API
    #: image — the agent versions on its own schedule and should not drag a
    #: server deploy along with it.
    #:
    #: The default points at the repository's own build output so a developer
    #: checkout serves whatever `scripts/build.ps1` last produced, with no
    #: configuration at all. Docker overrides it to /data/agent.
    agent_dist_dir: Path = SERVER_ROOT.parent / "agent" / "dist"

    #: The address an employee types at the agent's setup prompt.
    #:
    #: Left blank on purpose. It is *not* derivable from base_domain and
    #: public_scheme: those build per-tenant subdomain URLs, and this deployment
    #: is reached on a bare host and a non-default port, so composing one here
    #: would produce a confidently wrong answer. Blank means the console falls
    #: back to the origin the administrator is already looking at — which is the
    #: right answer whenever the console and API share a host, as they do behind
    #: the bundled nginx. Set it only when they do not.
    agent_server_url: str = ""

    # --- payments (Razorpay) -------------------------------------------------
    # Leave the key id blank to run signup in "no payment gateway" mode: orders
    # are simulated locally so the whole flow is testable without credentials.
    # Never leave that on in production — see razorpay_live below.
    razorpay_key_id: str = ""
    razorpay_key_secret: str = ""
    razorpay_webhook_secret: str = ""
    razorpay_api_base: str = "https://api.razorpay.com/v1"
    # Guard rail: when true the app refuses to start without real keys, so a
    # production deploy cannot silently fall back to simulated payments.
    razorpay_live: bool = False

    @property
    def payments_configured(self) -> bool:
        return bool(self.razorpay_key_id and self.razorpay_key_secret)

    # --- email ---------------------------------------------------------------
    # Not here. The outbound mail connector is configured in the platform
    # console and stored in the database, so an operator can point it at a new
    # provider, or fix a rejected sender, without shell access to the server and
    # without a restart. See app.services.mailconfig.

    # --- limits --------------------------------------------------------------
    max_segments_per_batch: int = 500
    invitation_ttl_hours: int = 168  # 7 days
    password_reset_ttl_hours: int = 2
    verification_ttl_hours: int = 72
    trial_days: int = 14

    # --- HRMS ----------------------------------------------------------------
    # Additive only. Every one of these is a *fallback* for something an admin
    # can set per organisation in the console — none of them is the live value
    # for a tenant that has configured itself. An operator changing one here
    # must not silently move the ground under a company that already decided.

    #: Used when an office location does not carry its own radius.
    default_geofence_radius_m: int = 200
    #: "off" | "flag_only" | "required". The default is flag_only rather than
    #: required because hard-blocking a punch breaks the product the first time
    #: somebody's GPS drifts fifty metres indoors — see HRMS_EXPANSION_PLAN §2.2.
    geofence_enforcement_default: str = "flag_only"
    #: Local hour the nightly attendance-status stamp targets, per organisation.
    #: The job wakes hourly and acts on the orgs whose local time is in this
    #: window, so "midnight" means midnight where the company actually is.
    attendance_status_job_hour_local: int = 0
    #: How long an earned comp-off survives before it expires unused.
    comp_off_default_expiry_days: int = 90
    #: How far ahead "upcoming hires" reaches on the HR dashboard.
    onboarding_default_lookahead_days: int = 30

    # Slugs that would shadow infrastructure hosts or look official.
    reserved_slugs: str = (
        "www,app,api,admin,static,assets,cdn,mail,smtp,ftp,ns1,ns2,status,"
        "docs,help,support,blog,dashboard,billing,account,login,signup,auth,"
        "sentinel,hrdesktimesol,root,system,internal,test,staging,dev"
    )

    @property
    def is_production(self) -> bool:
        return self.environment.strip().lower() == "production"

    @property
    def using_default_secret(self) -> bool:
        return self.secret_key.startswith("dev-only")

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def reserved_slug_set(self) -> set[str]:
        return {s.strip().lower() for s in self.reserved_slugs.split(",") if s.strip()}

    @property
    def is_sqlite(self) -> bool:
        return self.database_url.startswith("sqlite")

    def tenant_url(self, slug: str, path: str = "") -> str:
        port = f":{self.public_port}" if self.public_port else ""
        return f"{self.public_scheme}://{slug}.{self.base_domain}{port}{path}"

    def marketing_url(self, path: str = "") -> str:
        port = f":{self.public_port}" if self.public_port else ""
        return f"{self.public_scheme}://{self.marketing_host}.{self.base_domain}{port}{path}"


@lru_cache
def get_settings() -> Settings:
    s = Settings()
    if s.storage_backend == "local":
        s.storage_dir.mkdir(parents=True, exist_ok=True)
    return s


settings = get_settings()
