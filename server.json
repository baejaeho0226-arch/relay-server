// npm install socket.io
const io = require("socket.io")(3000, {
    cors: { origin: "*" }
});

console.log("=== RELAY SERVER RUNNING ON PORT 3000 ===");

io.on("connection", (socket) => {
    // 1. C++ 또는 앱이 방에 입장
    socket.on("join_room", (roomId) => {
        socket.join(roomId);
        console.log(`[+] Device joined room: ${roomId}`);
    });

    // 2. 앱 -> C++ 신호 전달 ("1" 보내기)
    socket.on("send_command", (data) => {
        // data = { roomId: "ROOM_1234", command: "1" }
        io.to(data.roomId).emit("receive_command", data.command);
        console.log(`[>] Command '${data.command}' sent to room: ${data.roomId}`);
    });

    // 3. C++ -> 앱 알림 전달 ("2" 보내기)
    socket.on("send_notify", (data) => {
        // data = { roomId: "ROOM_1234", message: "2" }
        io.to(data.roomId).emit("receive_notify", data.message);
        console.log(`[<] Notify '${data.message}' sent to room: ${data.roomId}`);
    });
});