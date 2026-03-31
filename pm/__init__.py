"""Project-Manager CLI"""
import typer
from rich.console import Console

app = typer.Typer(name="pm")
console = Console()


@app.command()
def version():
    """Show version"""
    console.print("[bold green]pm[/bold green] v0.1.0")


@app.command()
def init(user: str):
    """Initialize project structure for a user"""
    console.print(f"[bold]Initializing[/bold] project for user: [cyan]{user}[/cyan]")


@app.command()
def log(content: str):
    """Add a daily log entry"""
    console.print(f"[bold]Log:[/bold] {content}")


@app.command()
def demand(content: str, priority: str = "P2"):
    """Create a demand/task"""
    console.print(f"[bold]Demand:[/bold] {content} [dim][{priority}][/dim]")


@app.command()
def issue(content: str, priority: str = "P2"):
    """Create an issue/problem"""
    console.print(f"[bold]Issue:[/bold] {content} [dim][{priority}][/dim]")


@app.command()
def principles(content: str):
    """Add a development principle"""
    console.print(f"[bold]Principle:[/bold] {content}")


@app.command()
def knowledge(content: str):
    """Add knowledge/reference"""
    console.print(f"[bold]Knowledge:[/bold] {content}")


@app.command()
def tmp(content: str):
    """Add temporary note (24h TTL)"""
    console.print(f"[bold]Tmp:[/bold] {content} [dim](24h TTL)[/dim]")


if __name__ == "__main__":
    app()
