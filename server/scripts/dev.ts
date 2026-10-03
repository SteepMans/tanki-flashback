import { spawn } from 'child_process';
import * as readline from 'readline';

function runServer() {
    console.log('Iniciando os servidores de desenvolvimento...');
    const command = 'ts-node-dev';
    const args = ['-r', 'tsconfig-paths/register', '--respawn', '--transpile-only', 'src/server.ts'];

    const serverProcess = spawn(command, args, { stdio: 'inherit', shell: true });

    serverProcess.on('close', (code) => {
        if (code !== 0) {
            console.error(`The development server exited unexpectedly with code ${code}.`);
        }
    });
}

function buildAndRun() {
    console.log('Iniciando o build dos recursos...');
    const buildProcess = spawn('npm', ['run', 'build:gen'], { stdio: 'inherit', shell: true });

    buildProcess.on('close', (code) => {
        if (code === 0) {
            console.log('Resource build completed successfully.');
            runServer();
        } else {
            console.error(`Resource build failed with code ${code}. The server will not be started.`);
            process.exit(code ?? 1);
        }
    });

    buildProcess.on('error', (err) => {
        console.error(`Falha ao executar o build de recursos: ${err.message}`);
        process.exit(1);
    });
}

// Permite definir o comportamento por parâmetro, evitando o prompt interativo (necessário no pm2):
//   npm run dev -- --build     -> builda os recursos e executa
//   npm run dev -- --no-build  -> executa direto (sem build)
// Sem parâmetro: usa o prompt interativo se houver TTY; caso contrário, executa direto.
const args = process.argv.slice(2);
const wantsBuild = args.includes('--build') || args.includes('-b') || args.includes('build');
const skipBuild = args.includes('--no-build') || args.includes('-n');

if (wantsBuild) {
    buildAndRun();
} else if (skipBuild || !process.stdin.isTTY) {
    runServer();
} else {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    console.log('How would you like to start the development environment?');
    console.log('1 - Run servers (default)');
    console.log('2 - Buildar recursos e executar servidores');
    console.log('');

    rl.question('Choose an option (press Enter for the default): ', (answer) => {
        rl.close();
        if (answer.trim() === '2') buildAndRun();
        else runServer();
    });
}
