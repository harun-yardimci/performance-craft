<?php
class OrderController {
    public function index() {
        $orders = Order::latest()->paginate(50);
        foreach ($orders as $order) {
            $order->customer_name = Customer::where('id', $order->customer_id)->first()->name;
        }
        return view('orders.index', compact('orders'));
    }
    public function export() {
        return Order::all();
    }
}
