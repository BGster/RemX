"""pm init command - initialize project directory structure."""
from pathlib import Path

from rich.console import Console
from rich.tree import Tree

from ..config import Config
from ..db import init_db

console = Console()


def init_user(user: str, config_path: Path, force: bool = False) -> None:
    """Initialize project structure for a user."""
    root = config_path.parent.resolve()

    # Load or create config
    config = Config.load(config_path)

    # Determine if this is a fresh init
    is_fresh = not config_path.exists()

    # Update config
    config.user.id = user
    config.user.workspace = f"{user}/"
    config.project.root = "."

    # Ensure user is in users list
    if user not in config.users:
        config.users.append(user)

    config.save(config_path)

    # Create database if needed
    db_path = root / "memory.db"
    if not db_path.exists():
        init_db(db_path)

    # Create share directories (always global)
    share_dirs = [
        root / "share" / "projects",
        root / "share" / "milestones",
        root / "share" / "meetings",
        root / "share" / "issues",
        root / "share" / "knowledge",
    ]

    # Create user-private directories
    user_dirs = [
        root / user / "principles",
        root / user / "daily",
        root / user / "demands",
        root / user / "tmp",
    ]

    # Build tree output
    tree = Tree(f"[bold]Initialized project for user:[/bold] [cyan]{user}[/cyan]")

    share_tree = tree.add("[bold]share/[/bold]")
    for d in share_dirs:
        d.mkdir(parents=True, exist_ok=True)
        share_tree.add(f"{d.name}/")

    user_tree = tree.add(f"[bold]{user}/[/bold]")
    for d in user_dirs:
        d.mkdir(parents=True, exist_ok=True)
        user_tree.add(f"{d.name}/")

    info_tree = tree.add("[bold]Config & Data[/bold]")
    info_tree.add(f"Config: {config_path.name}")
    info_tree.add(f"Database: {db_path.name}")

    console.print(tree)

    if is_fresh:
        console.print(f"\n[dim]Project root: {root}[/dim]")
