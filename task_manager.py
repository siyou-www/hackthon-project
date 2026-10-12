tasks = []

def add_task(name):
    task = {
        "name": name,
        "completed": False
    }
    tasks.append(task)

def show_tasks():
    for i, task in enumerate(tasks, start=1):
        status = "Done" if task["completed"] else "Not done"
        print(f"{i}. {task['name']} - {status}")

add_task("Learn Python")
add_task("Practice Git")
add_task("Build an AI Agent")

tasks[1]["completed"] = True
show_tasks()